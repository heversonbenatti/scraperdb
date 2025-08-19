// components/Login.js
import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function Login({ onLogin, onGuest }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;
      
      onLogin('admin');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <h1>PC Scraper - Acesso</h1>
      
      <form onSubmit={handleAdminLogin} className="login-form">
        <h2>Login Admin</h2>
        
        <div className="form-group">
          <label>Email:</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        
        <div className="form-group">
          <label>Senha:</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        
        {error && <div className="error-message">{error}</div>}
        
        <button type="submit" disabled={loading} className="login-button">
          {loading ? 'Carregando...' : 'Entrar como Admin'}
        </button>
      </form>
      
      <div className="guest-section">
        <h2>Ou</h2>
        <button onClick={() => onGuest('guest')} className="guest-button">
          Entrar como Visitante
        </button>
      </div>

      <style jsx>{`
        .login-container {
          max-width: 400px;
          margin: 2rem auto;
          padding: 2rem;
          background-color: #1e1e1e;
          border-radius: 8px;
          color: #e0e0e0;
          text-align: center;
        }
        
        .login-form {
          margin-bottom: 2rem;
          padding: 1rem;
          background-color: #252525;
          border-radius: 8px;
        }
        
        .form-group {
          margin-bottom: 1rem;
          text-align: left;
        }
        
        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
        }
        
        .form-group input {
          width: 100%;
          padding: 0.5rem;
          background-color: #333;
          color: #e0e0e0;
          border: 1px solid #444;
          border-radius: 4px;
        }
        
        .error-message {
          color: #ff6b6b;
          margin: 1rem 0;
        }
        
        .login-button {
          width: 100%;
          padding: 0.75rem;
          background-color: #1971c2;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
        }
        
        .login-button:disabled {
          background-color: #555;
          cursor: not-allowed;
        }
        
        .guest-section {
          padding: 1rem;
        }
        
        .guest-button {
          width: 100%;
          padding: 0.75rem;
          background-color: #2b8a3e;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
        }
      `}</style>
    </div>
  );
}