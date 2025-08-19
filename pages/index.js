// index.js
import { supabase } from '../lib/supabaseClient';
import { useEffect, useState } from 'react';
import Login from '../components/login';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function PriceTracker() {
  const [userRole, setUserRole] = useState(null); // 'admin', 'guest', or null
  const [builds, setBuilds] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchConfigs, setSearchConfigs] = useState([]);
  const [activeTab, setActiveTab] = useState('builds');
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  const [filterCategory, setFilterCategory] = useState('all');

  // Form states
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
  const [newBuild, setNewBuild] = useState({
    name: '',
    categories: []
  });
  const [showBuildForm, setShowBuildForm] = useState(false);

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
        // Fetch builds first
        const { data: buildsData, error: buildsError } = await supabase
          .from('builds')
          .select('*')
          .order('created_at', { ascending: false });

        if (buildsError) throw buildsError;
        setBuilds(buildsData || []);

        // Fetch products and prices
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

        const pricesPromises = productsData.map(async (product) => {
          const { data: priceData, error: priceError } = await supabase
            .from('prices')
            .select('price, collected_at')
            .eq('product_id', product.id)
            .order('collected_at', { ascending: false })
            .limit(1)
            .single()

          return {
            ...product,
            price: priceData?.price || 0,
            lastUpdated: priceData?.collected_at
          }
        });

        const productsWithPrices = (await Promise.all(pricesPromises))
          .filter(product => product.price > 0);
        
        setProducts(productsWithPrices);
        
        // Fetch search configurations with keyword groups
        await fetchSearchConfigs();
        
        setLoading(false)
      } catch (error) {
        console.error('Error fetching data:', error)
        setLoading(false)
      }
    }

    const fetchSearchConfigs = async () => {
      try {
        // First get search configs
        const { data: configsData, error: configsError } = await supabase
          .from('search_configs')
          .select('*')
          .order('created_at', { ascending: false });
        
        if (configsError) throw configsError;
        
        // Then get keyword groups for each config
        const configsWithKeywords = await Promise.all(
          configsData.map(async (config) => {
            const { data: keywordData, error: keywordError } = await supabase
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
    const productsSubscription = supabase
      .channel('price-changes')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'prices'
      }, payload => {
        const updatedProduct = {
          id: payload.new.product_id,
          price: payload.new.price,
          lastUpdated: payload.new.collected_at
        }
        setProducts(prev => {
          const updated = prev.map(item => 
            item.id === updatedProduct.id ? 
            { ...item, price: updatedProduct.price, lastUpdated: updatedProduct.lastUpdated } : 
            item
          )
          return updated
        })
      })
      .subscribe()

    const configsSubscription = supabase
      .channel('config-changes')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'search_configs'
      }, async payload => {
        // Refetch all search configs when there's a change
        await fetchSearchConfigs();
      })
      .subscribe()

    const keywordGroupsSubscription = supabase
      .channel('keyword-groups-changes')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'keyword_groups'
      }, async payload => {
        // Refetch all search configs when keyword groups change
        await fetchSearchConfigs();
      })
      .subscribe()

    const buildsSubscription = supabase
      .channel('build-changes')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'builds'
      }, payload => {
        if (payload.eventType === 'INSERT') {
          setBuilds(prev => [payload.new, ...prev])
        } else if (payload.eventType === 'UPDATE') {
          setBuilds(prev => prev.map(build => 
            build.id === payload.new.id ? payload.new : build
          ))
        } else if (payload.eventType === 'DELETE') {
          setBuilds(prev => prev.filter(build => build.id !== payload.old.id))
        }
      })
      .subscribe()

    return () => {
      supabase.removeChannel(productsSubscription)
      supabase.removeChannel(configsSubscription)
      supabase.removeChannel(keywordGroupsSubscription)
      supabase.removeChannel(buildsSubscription)
    }
  }, [])

  // Fetch price history for product
  const fetchPriceHistory = async (productId) => {
    try {
      const { data, error } = await supabase
        .from('prices')
        .select('price, collected_at')
        .eq('product_id', productId)
        .order('collected_at', { ascending: true });

      if (error) throw error;

      const formattedData = data?.map(item => ({
        date: new Date(item.collected_at).toLocaleDateString('pt-BR'),
        price: parseFloat(item.price),
        timestamp: item.collected_at
      })) || [];

      setPriceHistory(formattedData);
    } catch (error) {
      console.error('Error fetching price history:', error);
      setPriceHistory([]);
    }
  };

  const handleProductClick = async (product) => {
    setSelectedProduct(product);
    await fetchPriceHistory(product.id);
  };

  // Calculate total price for a build
  const calculateBuildTotal = (buildCategories) => {
    if (!buildCategories || !products.length) return 0
    
    return buildCategories.reduce((total, category) => {
      const categoryProduct = products.find(item => item.category === category)
      return total + (categoryProduct?.price || 0)
    }, 0)
  }

  // Get filtered and sorted products
  const getFilteredAndSortedProducts = () => {
    let filtered = products;
    
    if (filterCategory !== 'all') {
      filtered = products.filter(p => p.category === filterCategory);
    }

    return filtered.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];
      
      if (sortBy === 'price') {
        aVal = parseFloat(aVal);
        bVal = parseFloat(bVal);
      }
      
      if (sortOrder === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });
  };

  // Build management functions
  const createBuild = async () => {
    if (!newBuild.name || newBuild.categories.length === 0) {
      alert('Build name and at least one category are required')
      return
    }

    const { data, error } = await supabase
      .from('builds')
      .insert([{
        name: newBuild.name,
        categories: newBuild.categories
      }])
      .select()

    if (!error) {
      setNewBuild({
        name: '',
        categories: []
      })
      setShowBuildForm(false)
    } else {
      console.error('Error creating build:', error)
    }
  }

  const toggleCategoryInBuild = (category) => {
    setNewBuild(prev => {
      if (prev.categories.includes(category)) {
        return {
          ...prev,
          categories: prev.categories.filter(c => c !== category)
        }
      } else {
        return {
          ...prev,
          categories: [...prev.categories, category]
        }
      }
    })
  }

  const deleteBuild = async (id) => {
    const { error } = await supabase
      .from('builds')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting build:', error)
    }
  }

  // Keyword group management
  const addKeywordGroup = () => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: [...prev.keywordGroups, '']
    }))
  }

  const removeKeywordGroup = (index) => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: prev.keywordGroups.filter((_, i) => i !== index)
    }))
  }

  const updateKeywordGroup = (index, value) => {
    setNewSearch(prev => ({
      ...prev,
      keywordGroups: prev.keywordGroups.map((group, i) => i === index ? value : group)
    }))
  }

  // Search configuration functions
  const addSearchConfig = async () => {
    if (!newSearch.search_text || !newSearch.category) {
      alert('Search term and category are required')
      return
    }

    // Filter out empty keyword groups and validate
    const validKeywordGroups = newSearch.keywordGroups
      .map(group => group.trim())
      .filter(group => group.length > 0)

    if (validKeywordGroups.length === 0) {
      alert('Add at least one keyword group')
      return
    }

    // Get selected websites
    const selectedWebsites = Object.entries(newSearch.websites)
      .filter(([_, isChecked]) => isChecked)
      .map(([website]) => website)

    if (selectedWebsites.length === 0) {
      alert('Select at least one website')
      return
    }

    try {
      // Create search configs for each selected website
      for (const website of selectedWebsites) {
        // First insert the search config
        const { data: configData, error: configError } = await supabase
          .from('search_configs')
          .insert([{
            search_text: newSearch.search_text,
            category: newSearch.category,
            website: website,
            is_active: newSearch.is_active
          }])
          .select()

        if (configError) throw configError

        const searchConfigId = configData[0].id

        // Then insert keyword groups
        const keywordGroupsData = validKeywordGroups.map(group => ({
          search_config_id: searchConfigId,
          keywords: group
        }))

        const { error: keywordError } = await supabase
          .from('keyword_groups')
          .insert(keywordGroupsData)

        if (keywordError) throw keywordError
      }

      // Reset form
      setNewSearch({
        search_text: '',
        keywordGroups: [''],
        category: '',
        websites: {
          kabum: false,
          pichau: false,
          terabyte: false
        },
        is_active: true
      })

      alert('Search configurations added successfully!')

    } catch (error) {
      console.error('Error adding search config:', error)
      alert('Error adding search configuration: ' + error.message)
    }
  }

  const toggleSearchActive = async (id, currentStatus) => {
    const newStatus = !currentStatus;
    
    // Optimistically update the UI
    setSearchConfigs(prevConfigs =>
      prevConfigs.map(config =>
        config.id === id ? { ...config, is_active: newStatus } : config
      )
    );

    try {
      const { error } = await supabase
        .from('search_configs')
        .update({ is_active: newStatus })
        .eq('id', id);

      if (error) {
        // Revert if the update fails
        setSearchConfigs(prevConfigs =>
          prevConfigs.map(config =>
            config.id === id ? { ...config, is_active: currentStatus } : config
          )
        );
        console.error('Error toggling search active status:', error);
      }
    } catch (err) {
      // Revert if there's an error
      setSearchConfigs(prevConfigs =>
        prevConfigs.map(config =>
          config.id === id ? { ...config, is_active: currentStatus } : config
        )
      );
      console.error('Error toggling search active status:', err);
    }
  };

  const deleteSearchConfig = async (id) => {
    try {
      // Delete keyword groups first (they should cascade delete, but being explicit)
      await supabase
        .from('keyword_groups')
        .delete()
        .eq('search_config_id', id)

      // Then delete the search config
      const { error } = await supabase
        .from('search_configs')
        .delete()
        .eq('id', id)

      if (error) throw error
    } catch (error) {
      console.error('Error deleting search config:', error)
      alert('Error deleting search configuration: ' + error.message)
    }
  }

  // Get unique categories
  const categories = [...new Set(products.map(p => p.category))];

  if (!userRole) {
    return (
      <Login 
        onLogin={(role) => setUserRole(role)} 
        onGuest={(role) => setUserRole(role)} 
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-300 text-lg">Carregando dados...</p>
        </div>
      </div>
    );
  }

  // Price history view
  if (selectedProduct) {
    const currentPrice = priceHistory[priceHistory.length - 1]?.price || selectedProduct.price;
    const previousPrice = priceHistory[priceHistory.length - 2]?.price || currentPrice;
    const priceChange = currentPrice - previousPrice;
    const priceChangePercent = previousPrice ? ((priceChange / previousPrice) * 100).toFixed(2) : 0;

    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black p-6">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <button
              onClick={() => setSelectedProduct(null)}
              className="flex items-center space-x-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
            >
              ← <span className="text-gray-300 ml-2">Voltar</span>
            </button>
            <h1 className="text-2xl font-bold text-white">Histórico de Preços</h1>
            <button
              onClick={() => {
                supabase.auth.signOut();
                setUserRole(null);
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
            >
              Sair
            </button>
          </div>

          {/* Product Info */}
          <div className="bg-gray-800 rounded-xl p-6 mb-8 border border-gray-700">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h2 className="text-xl font-semibold text-white mb-2">{selectedProduct.name}</h2>
                <div className="flex items-center space-x-4 text-gray-300">
                  <span className="px-3 py-1 bg-blue-600 rounded-full text-sm font-medium">
                    {selectedProduct.category.toUpperCase()}
                  </span>
                  <span className="px-3 py-1 bg-gray-700 rounded-full text-sm">
                    {selectedProduct.website}
                  </span>
                  <a 
                    href={selectedProduct.product_link} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded-full text-sm transition-colors"
                  >
                    Ver Produto
                  </a>
                </div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-white mb-1">
                  R$ {currentPrice.toFixed(2)}
                </div>
                <div className={`flex items-center space-x-1 ${priceChange >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  <span className="text-sm font-medium">
                    {priceChange >= 0 ? '↗' : '↘'} {priceChange >= 0 ? '+' : ''}R$ {priceChange.toFixed(2)} ({priceChangePercent}%)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Price Chart */}
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <div className="flex items-center space-x-2 mb-6">
              <h3 className="text-lg font-semibold text-white">Variação de Preço</h3>
            </div>
            <div className="h-96">
              {priceHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={priceHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis 
                      dataKey="date" 
                      stroke="#9CA3AF"
                      fontSize={12}
                    />
                    <YAxis 
                      stroke="#9CA3AF"
                      fontSize={12}
                      tickFormatter={(value) => `R$ ${value.toFixed(0)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1F2937',
                        border: '1px solid #374151',
                        borderRadius: '8px',
                        color: '#F3F4F6'
                      }}
                      formatter={(value) => [`R$ ${value.toFixed(2)}`, 'Preço']}
                    />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="#3B82F6"
                      strokeWidth={3}
                      dot={{ fill: '#3B82F6', r: 4 }}
                      activeDot={{ r: 6, stroke: '#3B82F6', strokeWidth: 2, fill: '#1E40AF' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-gray-400">Sem dados de histórico disponíveis</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Main application view
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black">
      {/* Header */}
      <header className="border-b border-gray-700 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
                <span className="text-white font-bold">PC</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                  PC Price Tracker
                </h1>
                <p className="text-gray-400 text-sm">Monitor de preços inteligente</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="flex bg-gray-800 rounded-lg p-1">
                <button
                  onClick={() => setActiveTab('builds')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === 'builds' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  Builds
                </button>
                <button
                  onClick={() => setActiveTab('products')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === 'products' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'
                  }`}
                >
                  Produtos
                </button>
                {userRole === 'admin' && (
                  <button
                    onClick={() => setActiveTab('admin')}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      activeTab === 'admin' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'
                    }`}
                  >
                    Admin
                  </button>
                )}
              </div>
              <button
                onClick={() => {
                  supabase.auth.signOut();
                  setUserRole(null);
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                Sair
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'builds' && (
          <div className="space-y-8">
            {/* Builds Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-3xl font-bold text-white mb-2">Builds Configuradas</h2>
                <p className="text-gray-400">Configurações completas de PC com preços atualizados</p>
              </div>
              {userRole === 'admin' && (
                <button
                  onClick={() => setShowBuildForm(!showBuildForm)}
                  className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                  <span>+</span>
                  <span>Nova Build</span>
                </button>
              )}
            </div>

            {/* Build Form */}
            {showBuildForm && userRole === 'admin' && (
              <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <h3 className="text-lg font-semibold text-white mb-4">Criar Nova Build</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-2">
                      Nome da Build
                    </label>
                    <input
                      type="text"
                      value={newBuild.name}
                      onChange={(e) => setNewBuild({...newBuild, name: e.target.value})}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Ex: Gaming PC 2024"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-2">
                      Categorias
                    </label>
                    <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto">
                      {categories.map(category => (
                        <label key={category} className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newBuild.categories.includes(category)}
                            onChange={() => toggleCategoryInBuild(category)}
                            className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                          />
                          <span className="text-gray-300 text-sm">{category.replace('_', ' ').toUpperCase()}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex space-x-4 mt-4">
                  <button
                    onClick={createBuild}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                  >
                    Criar Build
                  </button>
                  <button
                    onClick={() => setShowBuildForm(false)}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* Builds Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {builds.map(build => {
                const total = calculateBuildTotal(build.categories);
                return (
                  <div key={build.id} className="bg-gray-800 rounded-xl p-6 border border-gray-700 hover:border-blue-500 transition-colors group">
                    <div className="flex items-start justify-between mb-4">
                      <h3 className="text-lg font-semibold text-white group-hover:text-blue-400 transition-colors">
                        {build.name}
                      </h3>
                      {userRole === 'admin' && (
                        <button 
                          onClick={() => deleteBuild(build.id)}
                          className="text-gray-400 hover:text-red-400 transition-colors"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                    
                    <div className="space-y-3 mb-4">
                      {build.categories.map(category => {
                        const product = products.find(p => p.category === category);
                        return (
                          <div key={category} className="flex items-center justify-between">
                            <span className="text-gray-300 text-sm">{category.replace('_', ' ').toUpperCase()}</span>
                            {product ? (
                              <button
                                onClick={() => handleProductClick(product)}
                                className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors cursor-pointer"
                              >
                                R$ {product.price.toFixed(2)}
                              </button>
                            ) : (
                              <span className="text-gray-500 text-sm">N/A</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    
                    <div className="border-t border-gray-700 pt-4">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-300 font-medium">Total:</span>
                        <span className="text-xl font-bold text-green-400">
                          R$ {total.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'products' && (
          <div className="space-y-8">
            {/* Products Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-3xl font-bold text-white mb-2">Produtos Monitorados</h2>
                <p className="text-gray-400">Todos os produtos com preços atualizados em tempo real</p>
              </div>
              
              {/* Filters and Sort */}
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <span className="text-gray-400 text-sm">🔍</span>
                  <select
                    value={filterCategory}
                    onChange={(e) => setFilterCategory(e.target.value)}
                    className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">Todas as categorias</option>
                    {categories.map(category => (
                      <option key={category} value={category}>{category.replace('_', ' ').toUpperCase()}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                    className="p-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                  >
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </button>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="name">Nome</option>
                    <option value="category">Categoria</option>
                    <option value="price">Preço</option>
                    <option value="website">Loja</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Products Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {getFilteredAndSortedProducts().map(product => (
                <div
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className="bg-gray-800 rounded-xl p-6 border border-gray-700 hover:border-blue-500 cursor-pointer transition-all group hover:shadow-xl hover:shadow-blue-500/10"
                >
                  <div className="flex items-start justify-between mb-3">
                    <span className="px-2 py-1 bg-blue-600 text-white text-xs font-medium rounded-full">
                      {product.category.replace('_', ' ').toUpperCase()}
                    </span>
                    <span className="px-2 py-1 bg-gray-700 text-gray-300 text-xs rounded-full">
                      {product.website}
                    </span>
                  </div>
                  
                  <h3 className="text-white font-medium mb-3 group-hover:text-blue-400 transition-colors line-clamp-2">
                    {product.name}
                  </h3>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-2xl font-bold text-green-400">
                      R$ {product.price.toFixed(2)}
                    </span>
                    <span className="text-gray-400 group-hover:text-blue-400 transition-colors">📊</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'admin' && userRole === 'admin' && (
          <div className="space-y-8">
            {/* Admin Header */}
            <div>
              <h2 className="text-3xl font-bold text-white mb-2">Painel Administrativo</h2>
              <p className="text-gray-400">Gerencie configurações de busca e monitoramento</p>
            </div>

            {/* Search Config Form */}
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
              <h3 className="text-lg font-semibold text-white mb-4">Adicionar Nova Busca</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-2">Termo de Busca</label>
                    <input
                      type="text"
                      value={newSearch.search_text}
                      onChange={(e) => setNewSearch({...newSearch, search_text: e.target.value})}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500"
                      placeholder="Ex: ryzen 5 5600x"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-2">Categoria</label>
                    <input
                      type="text"
                      value={newSearch.category}
                      onChange={(e) => setNewSearch({...newSearch, category: e.target.value})}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500"
                      placeholder="Ex: cpu"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-gray-300 text-sm font-medium mb-2">Grupos de Palavras-chave</label>
                  {newSearch.keywordGroups.map((group, index) => (
                    <div key={index} className="flex gap-2 mb-2">
                      <input 
                        type="text" 
                        value={group}
                        onChange={(e) => updateKeywordGroup(index, e.target.value)}
                        className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-blue-500"
                        placeholder="Ex: x3d,5500,processador"
                      />
                      {newSearch.keywordGroups.length > 1 && (
                        <button 
                          type="button" 
                          onClick={() => removeKeywordGroup(index)}
                          className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                        >
                          Remover
                        </button>
                      )}
                    </div>
                  ))}
                  <button 
                    type="button" 
                    onClick={addKeywordGroup}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                  >
                    Adicionar Grupo
                  </button>
                  <p className="text-gray-400 text-xs mt-2">
                    Cada grupo deve conter palavras-chave separadas por vírgula. Todas as palavras de um grupo devem estar presentes no produto.
                  </p>
                </div>

                <div>
                  <label className="block text-gray-300 text-sm font-medium mb-2">Websites</label>
                  <div className="flex space-x-4">
                    {Object.keys(newSearch.websites).map(website => (
                      <label key={website} className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newSearch.websites[website]}
                          onChange={(e) => setNewSearch({
                            ...newSearch,
                            websites: {
                              ...newSearch.websites,
                              [website]: e.target.checked
                            }
                          })}
                          className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                        />
                        <span className="text-gray-300 text-sm capitalize">{website}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <input 
                    type="checkbox" 
                    id="is_active"
                    checked={newSearch.is_active}
                    onChange={(e) => setNewSearch({...newSearch, is_active: e.target.checked})}
                    className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <label htmlFor="is_active" className="text-gray-300 text-sm">Ativo</label>
                </div>

                <button 
                  onClick={addSearchConfig} 
                  className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                >
                  Adicionar Busca
                </button>
              </div>
            </div>

            {/* Search Configs Table */}
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
              <h3 className="text-lg font-semibold text-white mb-4">Configurações Ativas</h3>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Termo</th>
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Grupos</th>
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Categoria</th>
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Website</th>
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Status</th>
                      <th className="text-left py-3 px-4 text-gray-300 font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchConfigs.map(config => (
                      <tr key={config.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="py-3 px-4 text-white">{config.search_text}</td>
                        <td className="py-3 px-4">
                          <div className="flex flex-col gap-1">
                            {config.keywordGroups?.map((group, groupIdx) => (
                              <div key={groupIdx} className="bg-gray-700 px-2 py-1 rounded text-xs text-gray-300">
                                {group}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-1 bg-blue-600 text-white text-xs rounded-full">
                            {config.category.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-gray-300 capitalize">{config.website}</td>
                        <td className="py-3 px-4">
                          <button
                            onClick={() => toggleSearchActive(config.id, config.is_active)}
                            className={`flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                              config.is_active 
                                ? 'bg-green-600 hover:bg-green-700 text-white' 
                                : 'bg-red-600 hover:bg-red-700 text-white'
                            }`}
                          >
                            <span>{config.is_active ? '👁️' : '❌'}</span>
                            <span>{config.is_active ? 'Ativo' : 'Inativo'}</span>
                          </button>
                        </td>
                        <td className="py-3 px-4">
                          <button
                            onClick={() => deleteSearchConfig(config.id)}
                            className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                          >
                            🗑️
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Statistics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-400 text-sm">Total de Produtos</p>
                    <p className="text-2xl font-bold text-white">{products.length}</p>
                  </div>
                  <span className="text-3xl">📦</span>
                </div>
              </div>
              
              <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-400 text-sm">Builds Configuradas</p>
                    <p className="text-2xl font-bold text-white">{builds.length}</p>
                  </div>
                  <span className="text-3xl">⚙️</span>
                </div>
              </div>
              
              <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-400 text-sm">Buscas Ativas</p>
                    <p className="text-2xl font-bold text-white">
                      {searchConfigs.filter(c => c.is_active).length}
                    </p>
                  </div>
                  <span className="text-3xl">👁️</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* CSS Styles */}
      <style jsx>{`
        .line-clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        
        .bg-clip-text {
          -webkit-background-clip: text;
          background-clip: text;
        }
        
        .text-transparent {
          color: transparent;
        }
      `}</style>
    </div>
  );
}