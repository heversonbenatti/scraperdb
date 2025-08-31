import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Cliente público (para leitura e autenticação)
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// Cliente admin (service role - para operações administrativas)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Helper para verificar se o usuário está autenticado
export async function verifyAuthentication(req) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { isAuthenticated: false, user: null, error: 'No token provided' };
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);
    
    if (error || !user) {
      return { isAuthenticated: false, user: null, error: 'Invalid token' };
    }

    return { isAuthenticated: true, user, error: null };
  } catch (error) {
    return { isAuthenticated: false, user: null, error: error.message };
  }
}

// Helper para verificar se o usuário é admin
export async function verifyAdminRole(req) {
  const auth = await verifyAuthentication(req);
  
  if (!auth.isAuthenticated) {
    return { ...auth, isAdmin: false };
  }

  // No seu sistema atual, qualquer usuário autenticado é considerado admin
  // Ajuste esta lógica se quiser roles mais específicas no futuro
  const isAdmin = true; // Qualquer usuário autenticado é admin
  
  return { ...auth, isAdmin };
}

// Helper para criar cliente autenticado com token do usuário
export function createAuthenticatedClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });
}
