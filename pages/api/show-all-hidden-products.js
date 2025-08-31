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

    console.log('👁️ Mostrando todos os produtos ocultos...');

    // Buscar todos os produtos ocultos
    const { data: hiddenProducts, error: fetchError } = await supabaseAdmin
      .from('products')
      .select('id, name, hidden_reason')
      .eq('is_hidden', true);

    if (fetchError) {
      console.error('Error fetching hidden products:', fetchError);
      return res.status(500).json({ 
        error: 'Failed to fetch hidden products',
        details: fetchError.message
      });
    }

    if (!hiddenProducts || hiddenProducts.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Nenhum produto oculto encontrado',
        shownCount: 0
      });
    }

    const totalHidden = hiddenProducts.length;
    console.log(`📋 Encontrados ${totalHidden} produtos ocultos para mostrar`);

    // Agrupar por motivo para estatísticas
    const byReason = {
      manual: hiddenProducts.filter(p => p.hidden_reason === 'manual').length,
      price_limit_exceeded: hiddenProducts.filter(p => p.hidden_reason === 'price_limit_exceeded').length,
      other: hiddenProducts.filter(p => !['manual', 'price_limit_exceeded'].includes(p.hidden_reason)).length
    };

    // Mostrar todos os produtos de uma vez
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({
        is_hidden: false,
        hidden_reason: null,
        hidden_at: null
      })
      .eq('is_hidden', true)
      .select('id');

    if (error) {
      console.error('Error showing all products:', error);
      return res.status(500).json({ 
        error: 'Failed to show products',
        details: error.message
      });
    }

    const shownCount = data?.length || 0;
    console.log(`✅ ${shownCount} produtos foram mostrados com sucesso`);

    return res.status(200).json({
      success: true,
      message: `${shownCount} produto(s) foram mostrados com sucesso`,
      shownCount,
      previousStats: {
        total: totalHidden,
        manual: byReason.manual,
        priceLimit: byReason.price_limit_exceeded,
        other: byReason.other
      }
    });

  } catch (error) {
    console.error('Show all hidden products error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
