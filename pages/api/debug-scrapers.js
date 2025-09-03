import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Data de 15 minutos atrás
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // Buscar os dados mais recentes de cada website
    const { data: allPrices, error } = await supabaseClient
      .from('prices')
      .select(`
        product_id,
        price,
        last_checked_at,
        created_at,
        updated_at,
        products!inner(
          website,
          name,
          is_hidden
        )
      `)
      .eq('products.is_hidden', false)
      .order('last_checked_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Error fetching debug data:', error);
      return res.status(500).json({ error: 'Failed to fetch debug data' });
    }

    // Agrupar por website
    const websiteDebug = {};
    const websites = ['kabum', 'terabyte', 'pichau'];

    for (const website of websites) {
      const websitePrices = allPrices?.filter(p => p.products.website === website) || [];
      
      // Preços nos últimos 15 minutos
      const recentPrices = websitePrices.filter(p => 
        new Date(p.last_checked_at) >= fifteenMinutesAgo
      );

      // Últimos 5 registros desse website
      const latestPrices = websitePrices.slice(0, 5);

      websiteDebug[website] = {
        totalCount: websitePrices.length,
        recentCount: recentPrices.length,
        latest: latestPrices.map(p => ({
          product_name: p.products.name.substring(0, 50) + '...',
          price: p.price,
          last_checked_at: p.last_checked_at,
          created_at: p.created_at,
          updated_at: p.updated_at,
          minutes_ago: Math.round((new Date() - new Date(p.last_checked_at)) / (1000 * 60))
        }))
      };
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      fifteenMinutesAgo: fifteenMinutesAgo.toISOString(),
      debug: websiteDebug,
      totalRecords: allPrices?.length || 0
    });

  } catch (error) {
    console.error('Debug error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
