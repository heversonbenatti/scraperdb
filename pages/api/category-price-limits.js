import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Buscar todos os limites de preço
      const { data: limits, error } = await supabaseClient
        .from('category_price_limits')
        .select('*')
        .order('category', { ascending: true });

      if (error) {
        console.error('Error fetching price limits:', error);
        return res.status(500).json({ error: 'Failed to fetch price limits' });
      }

      // Buscar todas as categorias de produtos para garantir que temos todos os limites
      const { data: categories, error: categoriesError } = await supabaseClient
        .from('products')
        .select('category')
        .group('category');

      if (categoriesError) {
        console.error('Error fetching categories:', categoriesError);
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }

      // Garantir que todas as categorias tenham um limite (mesmo que inativo)
      const allCategories = [...new Set(categories?.map(c => c.category) || [])];
      const existingCategories = limits?.map(l => l.category) || [];
      const missingCategories = allCategories.filter(cat => !existingCategories.includes(cat));

      return res.status(200).json({
        success: true,
        limits: limits || [],
        missingCategories
      });

    } else if (req.method === 'POST') {
      // Criar ou atualizar limite de preço
      const { category, max_price, is_active } = req.body;

      if (!category || !max_price || max_price <= 0) {
        return res.status(400).json({ 
          error: 'category and max_price (> 0) are required' 
        });
      }

      const { data, error } = await supabaseClient
        .from('category_price_limits')
        .upsert({
          category,
          max_price: parseFloat(max_price),
          is_active: is_active !== false, // Default true
          updated_at: new Date().toISOString()
        })
        .select();

      if (error) {
        console.error('Error upserting price limit:', error);
        return res.status(500).json({ error: 'Failed to save price limit' });
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
      // Deletar limite de preço
      const { category } = req.body;

      if (!category) {
        return res.status(400).json({ error: 'category is required' });
      }

      const { error } = await supabaseClient
        .from('category_price_limits')
        .delete()
        .eq('category', category);

      if (error) {
        console.error('Error deleting price limit:', error);
        return res.status(500).json({ error: 'Failed to delete price limit' });
      }

      // Mostrar produtos que estavam escondidos por este limite
      await supabaseClient
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

// Função auxiliar para verificar e esconder produtos acima do limite
async function checkAndHideProductsAboveLimit(category, maxPrice) {
  try {
    // Buscar produtos da categoria com preços atuais
    const { data: products, error: productsError } = await supabaseClient
      .from('products')
      .select(`
        id, name, category, is_hidden, hidden_reason,
        prices!inner(price, price_changed_at)
      `)
      .eq('category', category)
      .eq('is_hidden', false)
      .order('prices(price_changed_at)', { ascending: false });

    if (productsError) {
      console.error('Error fetching products for price check:', productsError);
      return;
    }

    const productsToHide = [];
    const productsToShow = [];

    // Agrupar preços por produto (pegar só o mais recente)
    const productsWithLatestPrice = {};
    products?.forEach(product => {
      if (!productsWithLatestPrice[product.id] || 
          new Date(product.prices.price_changed_at) > new Date(productsWithLatestPrice[product.id].prices.price_changed_at)) {
        productsWithLatestPrice[product.id] = product;
      }
    });

    // Verificar quais produtos devem ser escondidos ou mostrados
    Object.values(productsWithLatestPrice).forEach(product => {
      const currentPrice = parseFloat(product.prices.price);
      
      if (currentPrice >= maxPrice) {
        productsToHide.push(product.id);
      } else if (product.hidden_reason === 'price_limit_exceeded') {
        productsToShow.push(product.id);
      }
    });

    // Esconder produtos que excedem o limite
    if (productsToHide.length > 0) {
      await supabaseClient
        .from('products')
        .update({
          is_hidden: true,
          hidden_reason: 'price_limit_exceeded',
          hidden_at: new Date().toISOString()
        })
        .in('id', productsToHide);
    }

    // Mostrar produtos que agora estão abaixo do limite
    if (productsToShow.length > 0) {
      await supabaseClient
        .from('products')
        .update({
          is_hidden: false,
          hidden_reason: null,
          hidden_at: null
        })
        .in('id', productsToShow);
    }

    console.log(`Price limit check for ${category}: ${productsToHide.length} hidden, ${productsToShow.length} shown`);
  } catch (error) {
    console.error('Error checking price limits:', error);
  }
}