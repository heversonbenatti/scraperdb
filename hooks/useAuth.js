import { useState, useEffect } from 'react';
import { supabaseClient } from '@/utils/supabase';

export const useAuth = () => {
  const [userRole, setUserRole] = useState('guest');
  const [showLogin, setShowLogin] = useState(false);
  const [loginCreds, setLoginCreds] = useState({ email: '', password: '' });

  useEffect(() => {
    // Só executa no cliente (não no SSR)
    if (typeof window === 'undefined') return;
    
    const checkSession = async () => {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) setUserRole('admin');
      } catch (error) {
        console.error('Error checking session:', error);
      }
    };
    
    checkSession();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: loginCreds.email,
      password: loginCreds.password,
    });
    if (!error) {
      setUserRole('admin');
      setShowLogin(false);
    }
  };

  const handleLogout = async () => {
    await supabaseClient.auth.signOut();
    setUserRole('guest');
  };

  return {
    userRole,
    showLogin,
    setShowLogin,
    loginCreds,
    setLoginCreds,
    handleLogin,
    handleLogout
  };
};