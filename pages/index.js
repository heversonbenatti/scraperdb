// index.js
import { supabase } from '../lib/supabaseClient';
import { useEffect, useState } from 'react';
import Login from '../components/login';

export default function PriceTracker() {
  const [userRole, setUserRole] = useState(null);
  const [builds, setBuilds] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchConfigs, setSearchConfigs] = useState([]);
  const [activeTab, setActiveTab] = useState('builds');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [sortBy, setSortBy] = useState('price'); // 'price' or 'category'
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc' or 'desc'
  const [searchTerm, setSearchTerm] = useState('');
  const [showBuildForm, setShowBuildForm] = useState(false);
  const [newBuild, setNewBuild] = useState({
    name: '',
    categories: []
  });
  const [newSearch, setNewSearch] = useState({
    search_text: '',
    keywordGroups: [''],
    category: '',
    websites: {
      kabum: false,
      pichau: false,
      terabyte: false
    },
    is_active: true
  });

  // Check if user is already logged in
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setUserRole('admin');
      }
      fetchInitialData();
    };

    const fetchInitialData = async () => {
      try {
        // Fetch builds
        const { data: buildsData, error: buildsError } = await supabase
          .from('builds')
          .select('*')
          .order('created_at', { ascending: false });

        if (buildsError) throw buildsError;
        setBuilds(buildsData || []);

        // Fetch all products with latest prices
        const { data: productsData, error: productsError } = await supabase
          .from('products')
          .select(`
            id,
            name,
            category,
            website,
            product_link
          `);

        if (productsError) throw productsError;

        // Get latest price for each product
        const productsWithPrices = await Promise.all(
          productsData.map(async (product) => {
            const { data: priceData } = await supabase
              .from('prices')
              .select('price, collected_at')
              .eq('product_id', product.id)
              .order('collected_at', { ascending: false })
              .limit(1)
              .single();

            return {
              ...product,
              currentPrice: priceData?.price || 0,
              lastUpdated: priceData?.collected_at
            };
          })
        );

        setProducts(productsWithPrices.filter(p => p.currentPrice > 0));
        
        // Fetch search configurations
        await fetchSearchConfigs();
        
        setLoading(false);
      } catch (error) {
        console.error('Error fetching data:', error);
        setLoading(false);
      }
    };

    const fetchSearchConfigs = async () => {
      try {
        const { data: configsData, error: configsError } = await supabase
          .from('search_configs')
          .select('*')
          .order('created_at', { ascending: false });
        
        if (configsError) throw configsError;
        
        const configsWithKeywords = await Promise.all(
          configsData.map(async (config) => {
            const { data: keywordData } = await supabase
              .from('keyword_groups')
              .select('keywords')
              .eq('search_config_id', config.id)
              .order('id', { ascending: true });
            
            return {
              ...config,
              keywordGroups: keywordData?.map(kg => kg.keywords) || []
            };
          })
        );
        
        setSearchConfigs(configsWithKeywords);
      } catch (error) {
        console.error('Error fetching search configs:', error);
      }
    };

    checkSession();

    // Set up realtime subscriptions
    const pricesSubscription = supabase
      .channel('price-changes')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'prices'
      }, async payload => {
        // Update product prices when new price is inserted
        setProducts(prev => prev.map(product => 
          product.id === payload.new.product_id 
            ? { ...product, currentPrice: payload.new.price, lastUpdated: payload.new.collected_at }
            : product
        ));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(pricesSubscription);
    };
  }, []);

  // Fetch price history for a product
  const fetchPriceHistory = async (productId) => {
    try {
      const { data, error } = await supabase
        .from('prices')
        .select('price, collected_at')
        .eq('product_id', productId)
        .order('collected_at', { ascending: true })
        .limit(30); // Last 30 price points

      if (error) throw error;
      setPriceHistory(data || []);
    } catch (error) {
      console.error('Error fetching price history:', error);
      setPriceHistory([]);
    }
  };

  // Show price modal
  const showPriceModal = async (product) => {
    setSelectedProduct(product);
    await fetchPriceHistory(product.id);
  };

  // Close price modal
  const closePriceModal = () => {
    setSelectedProduct(null);
    setPriceHistory([]);
  };

  // Sort products
  const getSortedProducts = () => {
    let sorted = [...products];
    
    // Filter by search term
    if (searchTerm) {
      sorted = sorted.filter(p => 
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.category.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Sort
    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'price') {
        comparison = a.currentPrice - b.currentPrice;
      } else if (sortBy === 'category') {
        comparison = a.category.localeCompare(b.category);
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  };

  // Calculate build total
  const calculateBuildTotal = (buildCategories) => {
    if (!buildCategories || !products.length) return 0;
    
    return buildCategories.reduce((total, category) => {
      const lowestInCategory = products
        .filter(p => p.category === category)
        .sort((a, b) => a.currentPrice - b.currentPrice)[0];
      return total + (lowestInCategory?.currentPrice || 0);
    }, 0);
  };

  // Get lowest price product for each category in build
  const getBuildProducts = (buildCategories) => {
    if (!buildCategories) return [];
    
    return buildCategories.map(category => {
      const categoryProducts = products.filter(p => p.category === category);
      return categoryProducts.sort((a, b) => a.currentPrice - b.currentPrice)[0];
    }).filter(Boolean);
  };

  // Build management
  const createBuild = async () => {
    if (!newBuild.name || newBuild.categories.length === 0) {
      alert('Nome e pelo menos uma categoria são obrigatórios');
      return;
    }

    const { error } = await supabase
      .from('builds')
      .insert([{
        name: newBuild.name,
        categories: newBuild.categories
      }]);

    if (!error) {
      setNewBuild({ name: '', categories: [] });
      setShowBuildForm(false);
      window.location.reload(); // Refresh to get new data
    }
  };

  const deleteBuild = async (id) => {
    if (confirm('Tem certeza que deseja remover esta build?')) {
      const { error } = await supabase
        .from('builds')
        .delete()
        .eq('id', id);

      if (!error) {
        setBuilds(prev => prev.filter(b => b.id !== id));
      }
    }
  };

  // Search config management
  const addKeywordGroup = () => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: [...prev.keywordGroups, '']
    }));
  };

  const removeKeywordGroup = (index) => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: prev.keywordGroups.filter((_, i) => i !== index)
    }));
  };

  const updateKeywordGroup = (index, value) => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: prev.keywordGroups.map((group, i) => i === index ? value : group)
    }));
  };

  const addSearchConfig = async () => {
    if (!newSearch.search_text || !newSearch.category) {
      alert('Termo de busca e categoria são obrigatórios');
      return;
    }

    const validKeywordGroups = newSearch.keywordGroups
      .map(group => group.trim())
      .filter(group => group.length > 0);

    if (validKeywordGroups.length === 0) {
      alert('Adicione pelo menos um grupo de palavras-chave');
      return;
    }

    const selectedWebsites = Object.entries(newSearch.websites)
      .filter(([_, isChecked]) => isChecked)
      .map(([website]) => website);

    if (selectedWebsites.length === 0) {
      alert('Selecione pelo menos um site');
      return;
    }

    try {
      for (const website of selectedWebsites) {
        const { data: configData, error: configError } = await supabase
          .from('search_configs')
          .insert([{
            search_text: newSearch.search_text,
            category: newSearch.category,
            website: website,
            is_active: newSearch.is_active
          }])
          .select();

        if (configError) throw configError;

        const searchConfigId = configData[0].id;

        const keywordGroupsData = validKeywordGroups.map(group => ({
          search_config_id: searchConfigId,
          keywords: group
        }));

        const { error: keywordError } = await supabase
          .from('keyword_groups')
          .insert(keywordGroupsData);

        if (keywordError) throw keywordError;
      }

      setNewSearch({
        search_text: '',
        keywordGroups: [''],
        category: '',
        websites: { kabum: false, pichau: false, terabyte: false },
        is_active: true
      });

      alert('Configurações adicionadas com sucesso!');
      window.location.reload();
    } catch (error) {
      console.error('Error adding search config:', error);
      alert('Erro ao adicionar configuração');
    }
  };

  const toggleSearchActive = async (id, currentStatus) => {
    const { error } = await supabase
      .from('search_configs')
      .update({ is_active: !currentStatus })
      .eq('id', id);

    if (!error) {
      setSearchConfigs(prev => prev.map(config =>
        config.id === id ? { ...config, is_active: !currentStatus } : config
      ));
    }
  };

  const deleteSearchConfig = async (id) => {
    if (confirm('Tem certeza que deseja remover esta configuração?')) {
      const { error } = await supabase
        .from('search_configs')
        .delete()
        .eq('id', id);

      if (!error) {
        setSearchConfigs(prev => prev.filter(c => c.id !== id));
      }
    }
  };

  if (!userRole) {
    return <Login onLogin={(role) => setUserRole(role)} onGuest={(role) => setUserRole(role)} />;
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Carregando dados...</p>
        <style jsx>{`
          .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            font-size: 1.2rem;
          }
          .loading-spinner {
            width: 50px;
            height: 50px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 1rem;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <h1 className="logo">
            <span className="logo-icon">🖥️</span>
            PC Scraper
          </h1>
          <nav className="nav-tabs">
            <button 
              className={`nav-tab ${activeTab === 'builds' ? 'active' : ''}`}
              onClick={() => setActiveTab('builds')}
            >
              <span className="tab-icon">🔧</span>
              Builds
            </button>
            <button 
              className={`nav-tab ${activeTab === 'products' ? 'active' : ''}`}
              onClick={() => setActiveTab('products')}
            >
              <span className="tab-icon">📦</span>
              Produtos
            </button>
            {userRole === 'admin' && (
              <button 
                className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
                onClick={() => setActiveTab('admin')}
              >
                <span className="tab-icon">⚙️</span>
                Admin
              </button>
            )}
          </nav>
          <button 
            onClick={() => {
              supabase.auth.signOut();
              setUserRole(null);
            }}
            className="logout-btn"
          >
            Sair
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Builds Tab */}
        {activeTab === 'builds' && (
          <div className="tab-content">
            <div className="section-header">
              <h2>Minhas Builds</h2>
              {userRole === 'admin' && (
                <button 
                  onClick={() => setShowBuildForm(!showBuildForm)}
                  className="add-btn"
                >
                  {showBuildForm ? 'Cancelar' : '+ Nova Build'}
                </button>
              )}
            </div>

            {showBuildForm && userRole === 'admin' && (
              <div className="form-card">
                <h3>Criar Nova Build</h3>
                <input 
                  type="text" 
                  placeholder="Nome da Build"
                  value={newBuild.name}
                  onChange={(e) => setNewBuild({...newBuild, name: e.target.value})}
                  className="input"
                />
                <div className="categories-grid">
                  {[...new Set(products.map(p => p.category))].map(category => (
                    <label key={category} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={newBuild.categories.includes(category)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewBuild({...newBuild, categories: [...newBuild.categories, category]});
                          } else {
                            setNewBuild({...newBuild, categories: newBuild.categories.filter(c => c !== category)});
                          }
                        }}
                      />
                      <span>{category.replace('_', ' ').toUpperCase()}</span>
                    </label>
                  ))}
                </div>
                <button onClick={createBuild} className="primary-btn">
                  Criar Build
                </button>
              </div>
            )}

            <div className="builds-grid">
              {builds.map(build => {
                const buildProducts = getBuildProducts(build.categories);
                const total = calculateBuildTotal(build.categories);
                
                return (
                  <div key={build.id} className="build-card">
                    <div className="build-header">
                      <h3>{build.name}</h3>
                      {userRole === 'admin' && (
                        <button 
                          onClick={() => deleteBuild(build.id)}
                          className="delete-btn"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                    <div className="build-products">
                      {buildProducts.map(product => (
                        <div key={product.id} className="build-product">
                          <div className="product-info">
                            <span className="product-category">
                              {product.category.replace('_', ' ').toUpperCase()}
                            </span>
                            <span className="product-name">{product.name}</span>
                          </div>
                          <div className="product-price-info">
                            <span className="product-price">R$ {product.currentPrice.toFixed(2)}</span>
                            <button 
                              onClick={() => showPriceModal(product)}
                              className="chart-btn"
                              title="Ver histórico de preços"
                            >
                              📊
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="build-footer">
                      <span className="build-total">Total: R$ {total.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Products Tab */}
        {activeTab === 'products' && (
          <div className="tab-content">
            <div className="section-header">
              <h2>Todos os Produtos</h2>
              <div className="filters">
                <input 
                  type="text"
                  placeholder="Buscar produtos..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
                <select 
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="select"
                >
                  <option value="price">Ordenar por Preço</option>
                  <option value="category">Ordenar por Categoria</option>
                </select>
                <button 
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="sort-order-btn"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>

            <div className="products-grid">
              {getSortedProducts().map(product => (
                <div key={product.id} className="product-card">
                  <div className="product-header">
                    <span className="product-category-badge">
                      {product.category.replace('_', ' ').toUpperCase()}
                    </span>
                    <span className="product-store">{product.website}</span>
                  </div>
                  <h4 className="product-title">{product.name}</h4>
                  <div className="product-footer">
                    <span className="product-price-large">R$ {product.currentPrice.toFixed(2)}</span>
                    <div className="product-actions">
                      <button 
                        onClick={() => showPriceModal(product)}
                        className="chart-btn"
                        title="Ver histórico"
                      >
                        📊
                      </button>
                      <a 
                        href={product.product_link} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="link-btn"
                        title="Ver na loja"
                      >
                        🔗
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Admin Tab */}
        {activeTab === 'admin' && userRole === 'admin' && (
          <div className="tab-content">
            <div className="section-header">
              <h2>Configurações de Busca</h2>
            </div>

            <div className="admin-form-card">
              <h3>Adicionar Nova Busca</h3>
              <div className="form-grid">
                <input 
                  type="text"
                  placeholder="Termo de busca (ex: amd ryzen 5)"
                  value={newSearch.search_text}
                  onChange={(e) => setNewSearch({...newSearch, search_text: e.target.value})}
                  className="input"
                />
                <input 
                  type="text"
                  placeholder="Categoria (ex: cpu_1)"
                  value={newSearch.category}
                  onChange={(e) => setNewSearch({...newSearch, category: e.target.value})}
                  className="input"
                />
              </div>

              <div className="keyword-groups">
                <label>Grupos de Palavras-chave:</label>
                {newSearch.keywordGroups.map((group, index) => (
                  <div key={index} className="keyword-group">
                    <input 
                      type="text"
                      placeholder="ex: x3d,5500,processador"
                      value={group}
                      onChange={(e) => updateKeywordGroup(index, e.target.value)}
                      className="input"
                    />
                    {newSearch.keywordGroups.length > 1 && (
                      <button 
                        onClick={() => removeKeywordGroup(index)}
                        className="remove-btn"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button onClick={addKeywordGroup} className="add-keyword-btn">
                  + Adicionar Grupo
                </button>
              </div>

              <div className="websites-selection">
                <label>Sites para buscar:</label>
                <div className="checkbox-group">
                  {Object.keys(newSearch.websites).map(website => (
                    <label key={website} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={newSearch.websites[website]}
                        onChange={(e) => setNewSearch({
                          ...newSearch,
                          websites: {...newSearch.websites, [website]: e.target.checked}
                        })}
                      />
                      <span>{website.charAt(0).toUpperCase() + website.slice(1)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button onClick={addSearchConfig} className="primary-btn">
                Adicionar Configuração
              </button>
            </div>

            <div className="configs-list">
              <h3>Configurações Ativas</h3>
              <div className="configs-grid">
                {searchConfigs.map(config => (
                  <div key={config.id} className="config-card">
                    <div className="config-header">
                      <span className="config-term">{config.search_text}</span>
                      <button 
                        onClick={() => deleteSearchConfig(config.id)}
                        className="delete-btn"
                      >
                        🗑️
                      </button>
                    </div>
                    <div className="config-details">
                      <span className="config-category">{config.category}</span>
                      <span className="config-website">{config.website}</span>
                      <button 
                        onClick={() => toggleSearchActive(config.id, config.is_active)}
                        className={`status-btn ${config.is_active ? 'active' : 'inactive'}`}
                      >
                        {config.is_active ? 'Ativo' : 'Inativo'}
                      </button>
                    </div>
                    <div className="config-keywords">
                      {config.keywordGroups.map((group, idx) => (
                        <span key={idx} className="keyword-tag">{group}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Price History Modal */}
      {selectedProduct && (
        <div className="modal-overlay" onClick={closePriceModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Histórico de Preços</h3>
              <button onClick={closePriceModal} className="close-btn">✕</button>
            </div>
            <div className="modal-body">
              <h4>{selectedProduct.name}</h4>
              <div className="price-chart">
                {priceHistory.length > 0 ? (
                  <div className="chart-container">
                    <div className="chart-bars">
                      {priceHistory.map((entry, idx) => {
                        const maxPrice = Math.max(...priceHistory.map(h => h.price));
                        const minPrice = Math.min(...priceHistory.map(h => h.price));
                        const height = ((entry.price - minPrice) / (maxPrice - minPrice)) * 100 || 50;
                        
                        return (
                          <div key={idx} className="chart-bar-wrapper">
                            <div 
                              className="chart-bar"
                              style={{ height: `${height}%` }}
                              title={`R$ ${entry.price.toFixed(2)} - ${new Date(entry.collected_at).toLocaleDateString()}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="chart-info">
                      <div className="price-stats">
                        <div className="stat">
                          <span className="stat-label">Menor:</span>
                          <span className="stat-value">R$ {Math.min(...priceHistory.map(h => h.price)).toFixed(2)}</span>
                        </div>
                        <div className="stat">
                          <span className="stat-label">Atual:</span>
                          <span className="stat-value current">R$ {selectedProduct.currentPrice.toFixed(2)}</span>
                        </div>
                        <div className="stat">
                          <span className="stat-label">Maior:</span>
                          <span className="stat-value">R$ {Math.max(...priceHistory.map(h => h.price)).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="price-variation">
                        {priceHistory.length > 1 && (
                          <>
                            <span className="variation-label">Variação:</span>
                            <span className={`variation-value ${priceHistory[priceHistory.length - 1].price > priceHistory[0].price ? 'up' : 'down'}`}>
                              {((priceHistory[priceHistory.length - 1].price - priceHistory[0].price) / priceHistory[0].price * 100).toFixed(1)}%
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="no-data">Sem dados de histórico disponíveis</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .app-container {
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        }

        .header {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(10px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .header-content {
          max-width: 1400px;
          margin: 0 auto;
          padding: 1rem 2rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 1rem;
        }

        .logo {
          font-size: 1.5rem;
          font-weight: bold;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .logo-icon {
          -webkit-text-fill-color: initial;
        }

        .nav-tabs {
          display: flex;
          gap: 0.5rem;
          flex: 1;
          justify-content: center;
        }

        .nav-tab {
          padding: 0.75rem 1.5rem;
          border: none;
          background: transparent;
          color: #6b7280;
          font-weight: 500;
          cursor: pointer;
          border-radius: 0.5rem;
          transition: all 0.3s;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .nav-tab:hover {
          background: rgba(103, 126, 234, 0.1);
          color: #667eea;
        }

        .nav-tab.active {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }

        .tab-icon {
          font-size: 1.2rem;
        }

        .logout-btn {
          padding: 0.75rem 1.5rem;
          background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
          color: white;
          border: none;
          border-radius: 0.5rem;
          cursor: pointer;
          font-weight: 500;
          transition: transform 0.2s;
        }

        .logout-btn:hover {
          transform: scale(1.05);
        }

        .main-content {
          max-width: 1400px;
          margin: 0 auto;
          padding: 2rem;
        }

        .tab-content {
          animation: fadeIn 0.3s ease-in;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
          flex-wrap: wrap;
          gap: 1rem;
        }

        .section-header h2 {
          color: white;
          font-size: 2rem;
        }

        .add-btn {
          padding: 0.75rem 1.5rem;
          background: rgba(255, 255, 255, 0.9);
          color: #667eea;
          border: none;
          border-radius: 0.5rem;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.3s;
        }

        .add-btn:hover {
          background: white;
          transform: scale(1.05);
        }

        .filters {
          display: flex;
          gap: 1rem;
          align-items: center;
          flex-wrap: wrap;
        }

        .search-input {
          padding: 0.75rem 1rem;
          border: none;
          border-radius: 0.5rem;
          background: rgba(255, 255, 255, 0.9);
          min-width: 250px;
          font-size: 1rem;
        }

        .select {
          padding: 0.75rem 1rem;
          border: none;
          border-radius: 0.5rem;
          background: rgba(255, 255, 255, 0.9);
          cursor: pointer;
          font-size: 1rem;
        }

        .sort-order-btn {
          padding: 0.75rem 1rem;
          background: rgba(255, 255, 255, 0.9);
          border: none;
          border-radius: 0.5rem;
          cursor: pointer;
          font-size: 1.2rem;
          transition: transform 0.2s;
        }

        .sort-order-btn:hover {
          transform: scale(1.1);
        }

        .form-card, .admin-form-card {
          background: rgba(255, 255, 255, 0.95);
          padding: 2rem;
          border-radius: 1rem;
          margin-bottom: 2rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        }

        .form-card h3, .admin-form-card h3 {
          color: #374151;
          margin-bottom: 1.5rem;
        }

        .input {
          width: 100%;
          padding: 0.75rem 1rem;
          border: 2px solid #e5e7eb;
          border-radius: 0.5rem;
          font-size: 1rem;
          transition: border-color 0.3s;
          margin-bottom: 1rem;
        }

        .input:focus {
          outline: none;
          border-color: #667eea;
        }

        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .categories-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 1rem;
          margin: 1rem 0;
        }

        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          padding: 0.5rem;
          border-radius: 0.5rem;
          transition: background 0.2s;
        }

        .checkbox-label:hover {
          background: rgba(103, 126, 234, 0.1);
        }

        .checkbox-label input[type="checkbox"] {
          width: 1.2rem;
          height: 1.2rem;
          cursor: pointer;
        }

        .primary-btn {
          padding: 0.75rem 2rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 0.5rem;
          cursor: pointer;
          font-weight: 500;
          font-size: 1rem;
          transition: transform 0.2s;
        }

        .primary-btn:hover {
          transform: scale(1.05);
        }

        .builds-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
          gap: 1.5rem;
        }

        .build-card {
          background: rgba(255, 255, 255, 0.95);
          border-radius: 1rem;
          padding: 1.5rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
          transition: transform 0.3s;
        }

        .build-card:hover {
          transform: translateY(-5px);
        }

        .build-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          padding-bottom: 1rem;
          border-bottom: 2px solid #e5e7eb;
        }

        .build-header h3 {
          color: #374151;
          font-size: 1.25rem;
        }

        .delete-btn {
          background: none;
          border: none;
          font-size: 1.2rem;
          cursor: pointer;
          transition: transform 0.2s;
          padding: 0.25rem;
        }

        .delete-btn:hover {
          transform: scale(1.2);
        }

        .build-products {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .build-product {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.75rem;
          background: #f9fafb;
          border-radius: 0.5rem;
          transition: background 0.2s;
        }

        .build-product:hover {
          background: #f3f4f6;
        }

        .product-info {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          flex: 1;
        }

        .product-category {
          font-size: 0.75rem;
          color: #6b7280;
          font-weight: 600;
          text-transform: uppercase;
        }

        .product-name {
          font-size: 0.9rem;
          color: #374151;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .product-price-info {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .product-price {
          font-weight: bold;
          color: #667eea;
          font-size: 1rem;
        }

        .chart-btn, .link-btn {
          background: none;
          border: none;
          font-size: 1.2rem;
          cursor: pointer;
          transition: transform 0.2s;
          padding: 0.25rem;
        }

        .chart-btn:hover, .link-btn:hover {
          transform: scale(1.2);
        }

        .build-footer {
          padding-top: 1rem;
          border-top: 2px solid #e5e7eb;
          text-align: right;
        }

        .build-total {
          font-size: 1.25rem;
          font-weight: bold;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .products-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 1.5rem;
        }

        .product-card {
          background: rgba(255, 255, 255, 0.95);
          border-radius: 1rem;
          padding: 1.5rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
          transition: transform 0.3s;
          display: flex;
          flex-direction: column;
        }

        .product-card:hover {
          transform: translateY(-5px);
        }

        .product-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .product-category-badge {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 0.25rem 0.75rem;
          border-radius: 1rem;
          font-size: 0.75rem;
          font-weight: 600;
        }

        .product-store {
          color: #6b7280;
          font-size: 0.85rem;
          font-weight: 500;
        }

        .product-title {
          color: #374151;
          font-size: 1rem;
          margin-bottom: 1rem;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
          flex: 1;
        }

        .product-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-top: 1rem;
          border-top: 1px solid #e5e7eb;
        }

        .product-price-large {
          font-size: 1.25rem;
          font-weight: bold;
          color: #667eea;
        }

        .product-actions {
          display: flex;
          gap: 0.5rem;
        }

        .keyword-groups {
          margin-bottom: 1.5rem;
        }

        .keyword-groups label {
          display: block;
          margin-bottom: 0.5rem;
          color: #374151;
          font-weight: 500;
        }

        .keyword-group {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }

        .remove-btn {
          padding: 0.75rem 1rem;
          background: #ef4444;
          color: white;
          border: none;
          border-radius: 0.5rem;
          cursor: pointer;
          transition: transform 0.2s;
        }

        .remove-btn:hover {
          transform: scale(1.05);
        }

        .add-keyword-btn {
          padding: 0.5rem 1rem;
          background: #f3f4f6;
          color: #374151;
          border: 2px dashed #d1d5db;
          border-radius: 0.5rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .add-keyword-btn:hover {
          background: #e5e7eb;
          border-color: #9ca3af;
        }

        .websites-selection {
          margin-bottom: 1.5rem;
        }

        .websites-selection label {
          display: block;
          margin-bottom: 0.5rem;
          color: #374151;
          font-weight: 500;
        }

        .checkbox-group {
          display: flex;
          gap: 1rem;
        }

        .configs-list {
          background: rgba(255, 255, 255, 0.95);
          padding: 2rem;
          border-radius: 1rem;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        }

        .configs-list h3 {
          color: #374151;
          margin-bottom: 1.5rem;
        }

        .configs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 1rem;
        }

        .config-card {
          background: #f9fafb;
          padding: 1rem;
          border-radius: 0.5rem;
          border: 1px solid #e5e7eb;
        }

        .config-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .config-term {
          font-weight: 600;
          color: #374151;
        }

        .config-details {
          display: flex;
          gap: 0.5rem;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .config-category, .config-website {
          padding: 0.25rem 0.5rem;
          background: #e5e7eb;
          border-radius: 0.25rem;
          font-size: 0.85rem;
          color: #4b5563;
        }

        .status-btn {
          padding: 0.25rem 0.75rem;
          border: none;
          border-radius: 0.25rem;
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 500;
          transition: all 0.2s;
        }

        .status-btn.active {
          background: #10b981;
          color: white;
        }

        .status-btn.inactive {
          background: #ef4444;
          color: white;
        }

        .config-keywords {
          display: flex;
          flex-wrap: wrap;
          gap: 0.25rem;
        }

        .keyword-tag {
          padding: 0.25rem 0.5rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border-radius: 0.25rem;
          font-size: 0.75rem;
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          animation: fadeIn 0.2s;
        }

        .modal {
          background: white;
          border-radius: 1rem;
          width: 90%;
          max-width: 600px;
          max-height: 80vh;
          overflow: auto;
          animation: slideUp 0.3s;
        }

        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1.5rem;
          border-bottom: 1px solid #e5e7eb;
        }

        .modal-header h3 {
          color: #374151;
        }

        .close-btn {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #6b7280;
          transition: color 0.2s;
        }

        .close-btn:hover {
          color: #374151;
        }

        .modal-body {
          padding: 1.5rem;
        }

        .modal-body h4 {
          color: #374151;
          margin-bottom: 1rem;
          font-size: 1.1rem;
        }

        .price-chart {
          margin-top: 1rem;
        }

        .chart-container {
          background: #f9fafb;
          padding: 1.5rem;
          border-radius: 0.5rem;
        }

        .chart-bars {
          display: flex;
          align-items: flex-end;
          height: 200px;
          gap: 2px;
          margin-bottom: 1rem;
        }

        .chart-bar-wrapper {
          flex: 1;
          height: 100%;
          display: flex;
          align-items: flex-end;
        }

        .chart-bar {
          width: 100%;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 2px 2px 0 0;
          transition: opacity 0.2s;
          cursor: pointer;
        }

        .chart-bar:hover {
          opacity: 0.8;
        }

        .chart-info {
          padding-top: 1rem;
          border-top: 1px solid #e5e7eb;
        }

        .price-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .stat {
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .stat-label {
          font-size: 0.85rem;
          color: #6b7280;
          margin-bottom: 0.25rem;
        }

        .stat-value {
          font-size: 1.1rem;
          font-weight: bold;
          color: #374151;
        }

        .stat-value.current {
          color: #667eea;
        }

        .price-variation {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 0.5rem;
        }

        .variation-label {
          color: #6b7280;
        }

        .variation-value {
          font-weight: bold;
          font-size: 1.1rem;
        }

        .variation-value.up {
          color: #ef4444;
        }

        .variation-value.down {
          color: #10b981;
        }

        .no-data {
          text-align: center;
          color: #6b7280;
          padding: 2rem;
        }

        @media (max-width: 768px) {
          .header-content {
            flex-direction: column;
            align-items: stretch;
          }

          .nav-tabs {
            order: 3;
            justify-content: stretch;
          }

          .nav-tab {
            flex: 1;
            justify-content: center;
          }

          .logout-btn {
            order: 2;
            width: 100%;
          }

          .builds-grid,
          .products-grid,
          .configs-grid {
            grid-template-columns: 1fr;
          }

          .filters {
            flex-direction: column;
            width: 100%;
          }

          .search-input,
          .select {
            width: 100%;
          }

          .modal {
            width: 95%;
            margin: 1rem;
          }

          .price-stats {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}