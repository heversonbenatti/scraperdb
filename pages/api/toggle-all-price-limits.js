import { supabaseAdmin, verifyAdminRole } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
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

    const { action } = req.body; // 'activate_all' ou 'deactivate_all'

    if (!action || !['activate_all', 'deactivate_all'].includes(action)) {
      return res.status(400).json({ 
        error: 'action must be activate_all or deactivate_all' 
      });
    }

    const isActive = action === 'activate_all';
    console.log(`🎯 ${isActive ? 'Ativando' : 'Desativando'} todos os limites de preço...`);

    // Primeiro buscar todos os limites existentes
    const { data: existingLimits, error: fetchError } = await supabaseAdmin
      .from('category_price_limits')
      .select('id, category, max_price');

    if (fetchError) {
      console.error('Error fetching existing limits:', fetchError);
      return res.status(500).json({ 
        error: 'Failed to fetch existing limits',
        details: fetchError.message
      });
    }

    if (!existingLimits || existingLimits.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Nenhum limite de preço encontrado para atualizar',
        updatedCount: 0
      });
    }

    // ✅ CORREÇÃO: Verificar se há limites antes de fazer UPDATE
    const limitIds = existingLimits.map(limit => limit.id);
    
    if (limitIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Nenhum limite de preço válido encontrado',
        updatedCount: 0
      });
    }

    // Atualizar todos os limites de preço usando IN com IDs
    const { data, error } = await supabaseAdmin
      .from('category_price_limits')
      .update({ 
        is_active: isActive,
        updated_at: new Date().toISOString()
      })
      .in('id', limitIds)
      .select();

    if (error) {
      console.error('Error updating all price limits:', error);
      return res.status(500).json({ 
        error: 'Failed to update price limits',
        details: error.message
      });
    }

    const updatedCount = data?.length || 0;
    console.log(`✅ ${updatedCount} limites de preço ${isActive ? 'ativados' : 'desativados'}`);

    // Se estamos ativando, verificar todos os limites ativos
    if (isActive && existingLimits && existingLimits.length > 0) {
      console.log('🔄 Verificando produtos para todos os limites ativados...');
      
      // Verificar cada categoria em paralelo para ser mais rápido
      const checkPromises = existingLimits.map(limit => 
        checkAndHideProductsAboveLimit(limit.category, parseFloat(limit.max_price))
      );
      
      await Promise.all(checkPromises);
      console.log('✅ Verificação de todos os limites concluída');
    } else if (!isActive) {
      // Se estamos desativando, mostrar todos os produtos escondidos por limite de preço
      console.log('🔓 Mostrando produtos escondidos por limite de preço...');
      
      const { data: shownProducts } = await supabaseAdmin
        .from('products')
        .update({
          is_hidden: false,
          hidden_reason: null,
          hidden_at: null
        })
        .eq('is_hidden', true)
        .eq('hidden_reason', 'price_limit_exceeded')
        .select('id');
      
      console.log(`✅ ${shownProducts?.length || 0} produtos mostrados após desativar limites`);
    }

    return res.status(200).json({
      success: true,
      message: `${updatedCount} limite(s) de preço ${isActive ? 'ativado(s)' : 'desativado(s)'} com sucesso`,
      updatedCount,
      action: isActive ? 'activated' : 'deactivated'
    });

  } catch (error) {
    console.error('Toggle all price limits error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}

// Função auxiliar simplificada para verificação rápida
async function checkAndHideProductsAboveLimit(category, maxPrice) {
  try {
    // Buscar produtos visíveis da categoria
    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .eq('category', category)
      .eq('is_hidden', false);

    if (!products || products.length === 0) return;

    const productsToHide = [];

    // Verificar preço de cada produto
    for (const product of products) {
      const { data: latestPrice } = await supabaseAdmin
        .from('prices')
        .select('price')
        .eq('product_id', product.id)
        .order('price_changed_at', { ascending: false })
        .limit(1)
        .single();

      if (latestPrice && parseFloat(latestPrice.price) >= maxPrice) {
        productsToHide.push(product.id);
      }
    }

    // Esconder produtos em lote
    if (productsToHide.length > 0) {
      await supabaseAdmin
        .from('products')
        .update({
          is_hidden: true,
          hidden_reason: 'price_limit_exceeded',
          hidden_at: new Date().toISOString()
        })
        .in('id', productsToHide);

      console.log(`🔒 ${productsToHide.length} produtos escondidos em ${category}`);
    }
  } catch (error) {
    console.error(`Error checking category ${category}:`, error.message);
  }
}
