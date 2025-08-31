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

    const { productId, action } = req.body;

    if (!productId || !action || !['hide', 'show'].includes(action)) {
      return res.status(400).json({ 
        error: 'productId and action (hide/show) are required' 
      });
    }

    let updateData;
    if (action === 'hide') {
      updateData = {
        is_hidden: true,
        hidden_reason: 'manual',
        hidden_at: new Date().toISOString()
      };
    } else {
      updateData = {
        is_hidden: false,
        hidden_reason: null,
        hidden_at: null
      };
    }

    // Usar cliente admin para operação
    const { data, error } = await supabaseAdmin
      .from('products')
      .update(updateData)
      .eq('id', productId)
      .select('id, name, is_hidden, hidden_reason');

    if (error) {
      console.error('Error toggling product visibility:', error);
      return res.status(500).json({ 
        error: 'Failed to update product visibility',
        details: error.message
      });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.status(200).json({
      success: true,
      message: `Produto ${action === 'hide' ? 'escondido' : 'mostrado'} com sucesso`,
      product: data[0]
    });

  } catch (error) {
    console.error('Toggle product visibility error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
