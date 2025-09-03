import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    console.log('Starting debug API...');
    
    // Primeiro, vamos ver se a conexão com supabase funciona
    const { data: basicTest, error: basicError } = await supabaseClient
      .from('products')
      .select('website')
      .limit(5);

    if (basicError) {
      console.error('Basic connection error:', basicError);
      return res.status(500).json({ 
        error: 'Basic connection failed',
        details: basicError.message 
      });
    }

    console.log('Basic test successful, found products:', basicTest?.length);

    // Agora vamos tentar buscar dados da tabela prices
    const { data: pricesTest, error: pricesError } = await supabaseClient
      .from('prices')
      .select('product_id, last_checked_at')
      .limit(10);

    if (pricesError) {
      console.error('Prices table error:', pricesError);
      return res.status(500).json({ 
        error: 'Prices table access failed',
        details: pricesError.message,
        basicTestWorked: true,
        basicTestCount: basicTest?.length
      });
    }

    console.log('Prices test successful, found records:', pricesTest?.length);

    // Tentar o join
    const { data: joinTest, error: joinError } = await supabaseClient
      .from('prices')
      .select(`
        product_id,
        last_checked_at,
        products(
          website
        )
      `)
      .limit(5);

    if (joinError) {
      console.error('Join test error:', joinError);
      return res.status(500).json({ 
        error: 'Join test failed',
        details: joinError.message,
        pricesTestWorked: true,
        pricesTestCount: pricesTest?.length
      });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      basicTest: {
        count: basicTest?.length,
        websites: [...new Set(basicTest?.map(p => p.website))]
      },
      pricesTest: {
        count: pricesTest?.length,
        latestTimestamp: pricesTest?.[0]?.last_checked_at
      },
      joinTest: {
        count: joinTest?.length,
        sample: joinTest?.slice(0, 3)
      }
    });

  } catch (error) {
    console.error('Debug API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
      stack: error.stack
    });
  }
}
