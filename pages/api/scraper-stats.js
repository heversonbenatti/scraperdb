import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Data de 15 minutos atrás
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // Lista de websites incluindo Pichau
    const websites = ['kabum', 'terabyte', 'pichau'];
    const scraperStats = [];

    for (const website of websites) {
      // Contar produtos atualizados nos últimos 15 minutos
      const { data: recentUpdates, error: recentError } = await supabaseClient
        .from('prices')
        .select('product_id, products!inner(website)')
        .gte('last_checked_at', fifteenMinutesAgo.toISOString())
        .eq('products.website', website)
        .eq('products.is_hidden', false);

      if (recentError) {
        console.error(`Error fetching recent updates for ${website}:`, recentError);
        // Continua mesmo com erro, mas conta como 0
      }

      const count = recentUpdates?.length || 0;
      
      // Status baseado na quantidade
      let status = 'normal';
      let statusColor = 'green';
      let statusIcon = '✅';

      if (count === 0) {
        status = 'offline';
        statusColor = 'red';
        statusIcon = '🔴';
      } else if (count < 10) {
        status = 'baixo';
        statusColor = 'yellow';
        statusIcon = '⚠️';
      } else if (count > 100) {
        status = 'alto';
        statusColor = 'blue';
        statusIcon = '🔥';
      }

      scraperStats.push({
        website,
        websiteName: website.charAt(0).toUpperCase() + website.slice(1),
        count,
        status,
        statusColor,
        statusIcon
      });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      timeframe: '15 minutos',
      stats: scraperStats,
      total: scraperStats.reduce((sum, s) => sum + s.count, 0)
    });

  } catch (error) {
    console.error('Scraper stats error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
