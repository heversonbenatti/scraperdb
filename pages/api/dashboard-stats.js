import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Data de 30 minutos atrás
    const thirtyMinutesAgo = new Date();
    thirtyMinutesAgo.setMinutes(thirtyMinutesAgo.getMinutes() - 30);

    // Data de 24 horas atrás para calcular média histórica
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    // Buscar todos os produtos para obter lista de websites ativos
    const { data: allProducts, error: productsError } = await supabaseClient
      .from('products')
      .select('website')
      .eq('is_hidden', false); // Considera apenas produtos visíveis

    if (productsError) {
      console.error('Error fetching products:', productsError);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }

    // Obter lista única de websites (excluindo pichau se comentado)
    const activeWebsites = [...new Set(allProducts.map(p => p.website))]
      .filter(website => website !== 'pichau'); // Manter pichau comentado conforme solicitado

    const websiteStats = [];

    for (const website of activeWebsites) {
      // Contar produtos atualizados nos últimos 30 minutos
      const { data: recentUpdates, error: recentError } = await supabaseClient
        .from('prices')
        .select('product_id, products!inner(website)')
        .gte('last_checked_at', thirtyMinutesAgo.toISOString())
        .eq('products.website', website)
        .eq('products.is_hidden', false);

      if (recentError) {
        console.error(`Error fetching recent updates for ${website}:`, recentError);
        continue;
      }

      const recentCount = recentUpdates?.length || 0;

      // Calcular média histórica (últimas 24h divididas por 48 períodos de 30min)
      const { data: historicalData, error: historicalError } = await supabaseClient
        .from('prices')
        .select('product_id, products!inner(website)')
        .gte('last_checked_at', twentyFourHoursAgo.toISOString())
        .eq('products.website', website)
        .eq('products.is_hidden', false);

      if (historicalError) {
        console.error(`Error fetching historical data for ${website}:`, historicalError);
      }

      const historicalCount = historicalData?.length || 0;
      // Média por período de 30min nas últimas 24h (48 períodos)
      const averagePer30Min = Math.round(historicalCount / 48);

      // Determinar status baseado na comparação com a média
      let status = 'normal';
      let statusColor = 'green';
      let statusIcon = '🟢';

      if (recentCount === 0) {
        status = 'offline';
        statusColor = 'red';
        statusIcon = '🔴';
      } else if (recentCount < averagePer30Min * 0.7) { // 30% abaixo da média
        status = 'baixo';
        statusColor = 'yellow';
        statusIcon = '🟡';
      } else if (recentCount > averagePer30Min * 1.5) { // 50% acima da média
        status = 'alto';
        statusColor = 'blue';
        statusIcon = '🔵';
      }

      websiteStats.push({
        website: website.toLowerCase(),
        websiteName: website.charAt(0).toUpperCase() + website.slice(1),
        recentCount,
        averagePer30Min,
        status,
        statusColor,
        statusIcon,
        lastUpdate: new Date().toISOString()
      });
    }

    // Adicionar estatística para Pichau (comentado/inativo)
    websiteStats.push({
      website: 'pichau',
      websiteName: 'Pichau',
      recentCount: 0,
      averagePer30Min: 0,
      status: 'comentado',
      statusColor: 'gray',
      statusIcon: '⚪',
      lastUpdate: new Date().toISOString()
    });

    // Ordenar por status e depois por nome
    websiteStats.sort((a, b) => {
      if (a.status === 'comentado') return 1;
      if (b.status === 'comentado') return -1;
      return a.websiteName.localeCompare(b.websiteName);
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      timeframe: '30 minutos',
      stats: websiteStats,
      summary: {
        totalActiveWebsites: activeWebsites.length,
        totalRecentUpdates: websiteStats
          .filter(s => s.status !== 'comentado')
          .reduce((sum, s) => sum + s.recentCount, 0),
        totalAverageUpdates: websiteStats
          .filter(s => s.status !== 'comentado')
          .reduce((sum, s) => sum + s.averagePer30Min, 0)
      }
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}