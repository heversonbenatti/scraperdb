import { supabaseAdmin } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🔄 Iniciando manutenção do sistema...');
    
    // 🕐 1. OCULTAR PRODUTOS NÃO ATUALIZADOS NAS ÚLTIMAS 24 HORAS
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    console.log(`📅 Buscando produtos não atualizados desde: ${twentyFourHoursAgo.toISOString()}`);
    
    // Buscar produtos que não foram atualizados nas últimas 24 horas e ainda estão visíveis
    const { data: outdatedProducts, error: outdatedError } = await supabaseAdmin
      .from('products')
      .select(`
        id, 
        name,
        prices (
          last_checked_at,
          price_changed_at
        )
      `)
      .eq('is_hidden', false)
      .order('id', { ascending: true });

    if (outdatedError) {
      throw new Error(`Erro ao buscar produtos: ${outdatedError.message}`);
    }

    console.log(`📊 Analisando ${outdatedProducts?.length || 0} produtos visíveis...`);

    let hiddenCount = 0;
    const productsToHide = [];

    for (const product of outdatedProducts || []) {
      if (!product.prices || product.prices.length === 0) {
        // Produto sem preços - ocultar
        productsToHide.push(product.id);
        continue;
      }

      // Pegar a última atualização (last_checked_at ou price_changed_at)
      const lastUpdate = product.prices.reduce((latest, price) => {
        const checkTime = new Date(price.last_checked_at || price.price_changed_at);
        return checkTime > latest ? checkTime : latest;
      }, new Date(0));

      if (lastUpdate < twentyFourHoursAgo) {
        productsToHide.push(product.id);
      }
    }

    console.log(`📋 Produtos para ocultar: ${productsToHide.length}`);

    // Ocultar produtos em lote - COM DEBUG - USANDO CLIENTE ADMIN
    if (productsToHide.length > 0) {
      console.log(`🔧 Tentando ocultar produtos com IDs: [${productsToHide.slice(0, 5).join(', ')}...]`);
      
      const { data: updateResult, error: hideError } = await supabaseAdmin
        .from('products')
        .update({
          is_hidden: true,
          hidden_reason: 'outdated',
          hidden_at: new Date().toISOString()
        })
        .in('id', productsToHide)
        .select('id'); // Retornar IDs para confirmar

      if (hideError) {
        console.error('❌ Erro detalhado na ocultação:', hideError);
        throw new Error(`Erro ao ocultar produtos: ${hideError.message}`);
      }

      hiddenCount = updateResult?.length || 0;
      console.log(`✅ ${hiddenCount} produtos realmente ocultos (de ${productsToHide.length} tentados)`);
      
      if (hiddenCount !== productsToHide.length) {
        console.warn(`⚠️ DISCREPÂNCIA: Tentou ocultar ${productsToHide.length}, mas apenas ${hiddenCount} foram atualizados`);
      }
    }

    // 🔄 2. REATIVAR PRODUTOS QUE VOLTARAM A SER ATUALIZADOS
    const { data: hiddenOutdated, error: hiddenError } = await supabaseAdmin
      .from('products')
      .select(`
        id,
        name,
        prices (
          last_checked_at,
          price_changed_at
        )
      `)
      .eq('is_hidden', true)
      .eq('hidden_reason', 'outdated')
      .order('id', { ascending: true });

    if (hiddenError) {
      console.error('⚠️ Erro ao buscar produtos ocultos por desatualização:', hiddenError.message);
    }

    let reactivatedCount = 0;
    const productsToReactivate = [];

    for (const product of hiddenOutdated || []) {
      if (!product.prices || product.prices.length === 0) {
        continue;
      }

      // Verificar se foi atualizado recentemente
      const lastUpdate = product.prices.reduce((latest, price) => {
        const checkTime = new Date(price.last_checked_at || price.price_changed_at);
        return checkTime > latest ? checkTime : latest;
      }, new Date(0));

      if (lastUpdate >= twentyFourHoursAgo) {
        productsToReactivate.push(product.id);
      }
    }

    console.log(`📋 Produtos para reativar: ${productsToReactivate.length}`);

    // Reativar produtos em lote - COM DEBUG - USANDO CLIENTE ADMIN
    if (productsToReactivate.length > 0) {
      const { data: reactivateResult, error: reactivateError } = await supabaseAdmin
        .from('products')
        .update({
          is_hidden: false,
          hidden_reason: null,
          hidden_at: null
        })
        .in('id', productsToReactivate)
        .select('id'); // Retornar IDs para confirmar

      if (reactivateError) {
        console.error('⚠️ Erro ao reativar produtos:', reactivateError.message);
      } else {
        reactivatedCount = reactivateResult?.length || 0;
        console.log(`✅ ${reactivatedCount} produtos realmente reativados`);
      }
    }

    // 📊 3. ESTATÍSTICAS FINAIS - COM DELAY PARA GARANTIR CONSISTÊNCIA
    await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
    
    const { data: totalStats, error: statsError } = await supabaseAdmin
      .from('products')
      .select('is_hidden, hidden_reason')
      .order('id', { ascending: true });

    let stats = {
      total: 0,
      visible: 0,
      hidden_manual: 0,
      hidden_price_limit: 0,
      hidden_outdated: 0,
      hidden_other: 0
    };

    if (!statsError && totalStats) {
      stats.total = totalStats.length;
      stats.visible = totalStats.filter(p => !p.is_hidden).length;
      stats.hidden_manual = totalStats.filter(p => p.is_hidden && p.hidden_reason === 'manual').length;
      stats.hidden_price_limit = totalStats.filter(p => p.is_hidden && p.hidden_reason === 'price_limit_exceeded').length;
      stats.hidden_outdated = totalStats.filter(p => p.is_hidden && p.hidden_reason === 'outdated').length;
      stats.hidden_other = totalStats.filter(p => p.is_hidden && !['manual', 'price_limit_exceeded', 'outdated'].includes(p.hidden_reason)).length;
    }

    // 🔍 DEBUG: Verificar se as estatísticas batem
    const expectedVisible = (outdatedProducts?.length || 0) - hiddenCount + reactivatedCount;
    console.log(`🔍 DEBUG: Produtos iniciais visíveis: ${outdatedProducts?.length || 0}, ocultos: ${hiddenCount}, reativados: ${reactivatedCount}`);
    console.log(`🔍 DEBUG: Esperado visível: ${expectedVisible}, real visível: ${stats.visible}`);

    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      actions_performed: {
        products_hidden: hiddenCount,
        products_reactivated: reactivatedCount
      },
      current_stats: stats,
      debug_info: {
        products_to_hide_attempted: productsToHide.length,
        products_actually_hidden: hiddenCount,
        expected_visible: expectedVisible,
        actual_visible: stats.visible,
        consistency_check: expectedVisible === stats.visible ? '✅ OK' : '❌ INCONSISTENTE'
      },
      message: `Manutenção concluída: ${hiddenCount} ocultos, ${reactivatedCount} reativados`
    };

    console.log('✅ Manutenção do sistema concluída:', result);

    return res.status(200).json(result);

  } catch (error) {
    console.error('❌ Erro na manutenção do sistema:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno na manutenção',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
