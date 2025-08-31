import { supabaseClient, supabaseAdmin, verifyAdminRole } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Leitura pode usar cliente público (se houver política de leitura)
      const { data: limits, error } = await supabaseClient
        .from('category_price_limits')
        .select('*')
        .order('category', { ascending: true });

      if (error) {
        console.error('Error fetching price limits:', error);
        return res.status(500).json({ 
          error: 'Failed to fetch price limits',
          details: error.message
        });
      }

      // Buscar todas as categorias de produtos para garantir que temos todos os limites
      const { data: categoriesData, error: categoriesError } = await supabaseClient
        .from('products')
        .select('category');

      if (categoriesError) {
        console.error('Error fetching categories:', categoriesError);
        return res.status(500).json({ 
          error: 'Failed to fetch categories',
          details: categoriesError.message
        });
      }

      // Extrair categorias únicas
      const allCategories = [...new Set(categoriesData?.map(c => c.category).filter(Boolean) || [])];
      const existingCategories = limits?.map(l => l.category) || [];
      const missingCategories = allCategories.filter(cat => !existingCategories.includes(cat));

      return res.status(200).json({
        success: true,
        limits: limits || [],
        missingCategories
      });

    } else if (req.method === 'POST') {
      // Verificar se o usuário é admin
      const auth = await verifyAdminRole(req);
      
      if (!auth.isAuthenticated) {
        return res.status(401).json({ 
          error: 'Authentication required',
          details: auth.error
        });
      }

      if (!auth.isAdmin) {
        return res.status(403).json({ 
          error: 'Admin access required' 
        });
      }

      // Criar ou atualizar limite de preço
      const { category, max_price, is_active } = req.body;

      if (!category || !max_price || max_price <= 0) {
        return res.status(400).json({ 
          error: 'category and max_price (> 0) are required' 
        });
      }

      // Primeiro, tentar atualizar
      const { data: updateData, error: updateError } = await supabaseAdmin
        .from('category_price_limits')
        .update({
          max_price: parseFloat(max_price),
          is_active: is_active !== false, // Default true
          updated_at: new Date().toISOString()
        })
        .eq('category', category)
        .select();

      let data = updateData;
      let error = updateError;

      // Se não atualizou nenhuma linha (categoria não existe), inserir nova
      if (!error && (!data || data.length === 0)) {
        const { data: insertData, error: insertError } = await supabaseAdmin
          .from('category_price_limits')
          .insert({
            category,
            max_price: parseFloat(max_price),
            is_active: is_active !== false, // Default true
          })
          .select();
        
        data = insertData;
        error = insertError;
      }

      if (error) {
        console.error('Error saving price limit:', error);
        return res.status(500).json({ 
          error: 'Failed to save price limit',
          details: error.message
        });
      }

      // Se ativamos um limite, verificar produtos que excedem
      if (is_active !== false) {
        await checkAndHideProductsAboveLimit(category, parseFloat(max_price));
      }

      return res.status(200).json({
        success: true,
        message: `Limite de preço para ${category} ${is_active !== false ? 'ativado' : 'desativado'}`,
        limit: data[0]
      });

    } else if (req.method === 'DELETE') {
      // Verificar se o usuário é admin
      const auth = await verifyAdminRole(req);
      
      if (!auth.isAuthenticated) {
        return res.status(401).json({ 
          error: 'Authentication required',
          details: auth.error
        });
      }

      if (!auth.isAdmin) {
        return res.status(403).json({ 
          error: 'Admin access required' 
        });
      }

      // Deletar limite de preço
      const { category } = req.body;

      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }

      const { error } = await supabaseAdmin
        .from('category_price_limits')
        .delete()
        .eq('category', category);

      if (error) {
        console.error('Error deleting price limit:', error);
        return res.status(500).json({ 
          error: 'Failed to delete price limit',
          details: error.message
        });
      }

      // Mostrar produtos que estavam escondidos por este limite
      await supabaseAdmin
        .from('products')
        .update({
          is_hidden: false,
          hidden_reason: null,
          hidden_at: null
        })
        .eq('category', category)
        .eq('hidden_reason', 'price_limit_exceeded');

      return res.status(200).json({
        success: true,
        message: `Limite de preço para ${category} removido e produtos mostrados`
      });

    } else {
      return res.status(405).json({ message: 'Method not allowed' });
    }

  } catch (error) {
    console.error('Price limits API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}

// Função auxiliar para verificar e esconder produtos acima do limite (OTIMIZADA)
async function checkAndHideProductsAboveLimit(category, maxPrice) {
  try {
    console.log(`🔍 Verificando categoria ${category} com limite R$ ${maxPrice}`);
    
    // 1. Buscar TODOS os produtos da categoria (visíveis e escondidos por preço)
    const { data: allProducts, error: productsError } = await supabaseClient
      .from('products')
      .select('id, name, category, is_hidden, hidden_reason')
      .eq('category', category)
      .or('is_hidden.eq.false,and(is_hidden.eq.true,hidden_reason.eq.price_limit_exceeded)');

    if (productsError) {
      console.error('Error fetching products for price check:', productsError);
      return;
    }

    if (!allProducts || allProducts.length === 0) {
      console.log(`ℹ️ Nenhum produto encontrado na categoria ${category}`);
      return;
    }

    // 2. Buscar TODOS os preços mais recentes de uma vez
    const productIds = allProducts.map(p => p.id);
    
    const { data: allPrices, error: pricesError } = await supabaseClient
      .rpc('get_latest_prices_by_products', { product_ids: productIds });

    // Se a função RPC não existir, usar abordagem padrão
    let latestPrices = [];
    if (pricesError || !allPrices) {
      console.log('🔄 Usando busca individual de preços (RPC não disponível)');
      
      // Buscar preços de forma mais eficiente
      for (const product of allProducts) {
        const { data: priceData } = await supabaseClient
          .from('prices')
          .select('product_id, price, price_changed_at')
          .eq('product_id', product.id)
          .order('price_changed_at', { ascending: false })
          .limit(1);
        
        if (priceData && priceData[0]) {
          latestPrices.push(priceData[0]);
        }
      }
    } else {
      latestPrices = allPrices;
    }

    // 3. Criar mapa de preços por produto
    const priceMap = {};
    latestPrices.forEach(price => {
      priceMap[price.product_id] = parseFloat(price.price);
    });

    // 4. Determinar quais produtos esconder e mostrar
    const productsToHide = [];
    const productsToShow = [];

    allProducts.forEach(product => {
      const currentPrice = priceMap[product.id];
      
      if (!currentPrice || currentPrice <= 0) {
        console.warn(`⚠️ Produto ${product.name} sem preço válido`);
        return;
      }

      const isCurrentlyHidden = product.is_hidden && product.hidden_reason === 'price_limit_exceeded';
      const shouldBeHidden = currentPrice >= maxPrice;

      if (!isCurrentlyHidden && shouldBeHidden) {
        // Produto visível mas deveria estar escondido
        productsToHide.push(product.id);
        console.log(`📦➡️🔒 Esconder: ${product.name} (R$ ${currentPrice})`);
      } else if (isCurrentlyHidden && !shouldBeHidden) {
        // Produto escondido mas deveria estar visível
        productsToShow.push(product.id);
        console.log(`🔓➡️📦 Mostrar: ${product.name} (R$ ${currentPrice})`);
      }
    });

    // 5. Executar operações em lote (mais rápido)
    const operations = [];

    if (productsToHide.length > 0) {
      operations.push(
        supabaseAdmin
          .from('products')
          .update({
            is_hidden: true,
            hidden_reason: 'price_limit_exceeded',
            hidden_at: new Date().toISOString()
          })
          .in('id', productsToHide)
      );
    }

    if (productsToShow.length > 0) {
      operations.push(
        supabaseAdmin
          .from('products')
          .update({
            is_hidden: false,
            hidden_reason: null,
            hidden_at: null
          })
          .in('id', productsToShow)
      );
    }

    // Executar todas as operações em paralelo
    if (operations.length > 0) {
      const results = await Promise.all(operations);
      const errors = results.filter(r => r.error);
      
      if (errors.length > 0) {
        console.error('Errors in batch operations:', errors);
      } else {
        console.log(`✅ Operações concluídas: ${productsToHide.length} escondidos, ${productsToShow.length} mostrados`);
      }
    } else {
      console.log(`😌 Nenhuma mudança necessária para ${category}`);
    }

  } catch (error) {
    console.error('Error in optimized price check:', error);
  }
}
