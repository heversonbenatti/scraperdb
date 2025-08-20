// index2.js - Versão completa melhorada
import { supabase } from '../lib/supabaseClient';
import { useEffect, useState } from 'react';
import Login from '../components/login';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';

export default function PriceTracker() {
  const [userRole, setUserRole] = useState(null); // 'admin', 'guest', or null
  const [builds, setBuilds] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedBuild, setSelectedBuild] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchConfigs, setSearchConfigs] = useState([]);
  const [activeTab, setActiveTab] = useState('builds');
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  const [filterCategory, setFilterCategory] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

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
  const [showSearchForm, setShowSearchForm] = useState(false);

  // Dashboard states
  const [dashboardStats, setDashboardStats] = useState({
    totalProducts: 0,
    totalBuilds: 0,
    activeSearches: 0,
    avgPrice: 0,
    priceRanges: [],
    categoryDistribution: []
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
        calculateDashboardStats(productsWithPrices, buildsData);
        
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

  // Calculate dashboard statistics
  const calculateDashboardStats = (productsData, buildsData) => {
    const totalProducts = productsData.length;
    const totalBuilds = buildsData?.length || 0;
    const activeSearches = searchConfigs.filter(c => c.is_active).length;
    
    const prices = productsData.map(p => p.price).filter(p => p > 0);
    const avgPrice = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0;

    // Price ranges
    const priceRanges = [
      { range: '0-500', count: prices.filter(p => p <= 500).length },
      { range: '500-1000', count: prices.filter(p => p > 500 && p <= 1000).length },
      { range: '1000-2000', count: prices.filter(p => p > 1000 && p <= 2000).length },
      { range: '2000+', count: prices.filter(p => p > 2000).length }
    ];

    // Category distribution
    const categoryCount = {};
    productsData.forEach(product => {
      categoryCount[product.category] = (categoryCount[product.category] || 0) + 1;
    });
    
    const categoryDistribution = Object.entries(categoryCount).map(([category, count]) => ({
      category: category.replace('_', ' ').toUpperCase(),
      count
    }));

    setDashboardStats({
      totalProducts,
      totalBuilds,
      activeSearches,
      avgPrice,
      priceRanges,
      categoryDistribution
    });
  };

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
      const categoryProducts = products.filter(item => item.category === category);
      const lowestPrice = Math.min(...categoryProducts.map(p => p.price), 0);
      return total + (lowestPrice > 0 ? lowestPrice : 0);
    }, 0)
  }

  // Get lowest priced products for build
  const getBuildProducts = (buildCategories) => {
    return buildCategories.map(category => {
      const categoryProducts = products.filter(item => item.category === category);
      return categoryProducts.reduce((lowest, current) => {
        return (!lowest || current.price < lowest.price) ? current : lowest;
      }, null);
    }).filter(Boolean);
  };

  // Get filtered and sorted products
  const getFilteredAndSortedProducts = () => {
    let filtered = products;
    
    if (filterCategory !== 'all') {
      filtered = products.filter(p => p.category === filterCategory);
    }

    if (searchTerm) {
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.category.toLowerCase().includes(searchTerm.toLowerCase())
      );
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

      setShowSearchForm(false);
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

  // Chart colors
  const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#F97316', '#06B6D4', '#84CC16'];

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
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-500 border-t-transparent mx-auto mb-6"></div>
          <h2 className="text-2xl font-semibold text-white mb-2">Carregando dados...</h2>
          <p className="text-gray-400">Aguarde enquanto sincronizamos os preços</p>
        </div>
      </div>
    );
  }

  // Build detail view
  if (selectedBuild) {
    const buildProducts = getBuildProducts(selectedBuild.categories);
    const total = calculateBuildTotal(selectedBuild.categories);

    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black p-6">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <button
              onClick={() => setSelectedBuild(null)}
              className="flex items-center space-x-2 px-4 py-2 bg-gray-700/50 hover:bg-gray-600/50 backdrop-blur-sm rounded-xl transition-all group"
            >
              <span className="group-hover:-translate-x-1 transition-transform">←</span>
              <span className="text-gray-300">Voltar para Builds</span>
            </button>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              {selectedBuild.name}
            </h1>
            <button
              onClick={() => {
                supabase.auth.signOut();
                setUserRole(null);
              }}
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 rounded-xl font-medium transition-all backdrop-blur-sm"
            >
              Sair
            </button>
          </div>

          {/* Build Summary */}
          <div className="bg-gradient-to-r from-gray-800/50 to-gray-700/50 backdrop-blur-sm rounded-2xl p-8 mb-8 border border-gray-700/50">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-white mb-2">Resumo da Build</h2>
                <p className="text-gray-400">Componentes selecionados com os melhores preços</p>
              </div>
              <div className="text-right">
                <p className="text-gray-400 text-sm mb-1">Total Estimado</p>
                <p className="text-4xl font-bold bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
                  R$ {total.toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          {/* Components Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {buildProducts.map((product, index) => (
              <div
                key={product.id}
                className="bg-gradient-to-br from-gray-800/50 to-gray-700/30 backdrop-blur-sm rounded-2xl p-6 border border-gray-700/50 hover:border-blue-500/50 transition-all group cursor-pointer"
                onClick={() => handleProductClick(product)}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="px-3 py-1 bg-blue-500/20 border border-blue-500/30 rounded-full">
                    <span className="text-blue-300 text-sm font-medium">
                      {product.category.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                  <div className="px-3 py-1 bg-gray-700/50 rounded-full">
                    <span className="text-gray-300 text-sm">{product.website}</span>
                  </div>
                </div>
                
                <h3 className="text-white font-semibold mb-4 group-hover:text-blue-400 transition-colors line-clamp-2">
                  {product.name}
                </h3>
                
                <div className="flex items-center justify-between">
                  <div className="text-2xl font-bold text-green-400">
                    R$ {product.price.toFixed(2)}
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-400 group-hover:text-blue-400 transition-colors">📊</span>
                    <span className="text-gray-400 text-sm">Ver gráfico</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
              className="flex items-center space-x-2 px-4 py-2 bg-gray-700/50 hover:bg-gray-600/50 backdrop-blur-sm rounded-xl transition-all group"
            >
              <span className="group-hover:-translate-x-1 transition-transform">←</span>
              <span className="text-gray-300">Voltar</span>
            </button>
            <h1 className="text-2xl font-bold text-white">Histórico de Preços</h1>
            <button
              onClick={() => {
                supabase.auth.signOut();
                setUserRole(null);
              }}
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 rounded-xl font-medium transition-all backdrop-blur-sm"
            >
              Sair
            </button>
          </div>

          {/* Product Info */}
          <div className="bg-gradient-to-r from-gray-800/50 to-gray-700/50 backdrop-blur-sm rounded-2xl p-8 mb-8 border border-gray-700/50">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h2 className="text-2xl font-semibold text-white mb-4">{selectedProduct.name}</h2>
                <div className="flex items-center space-x-4">
                  <span className="px-4 py-2 bg-blue-500/20 border border-blue-500/30 rounded-full text-blue-300 font-medium">
                    {selectedProduct.category.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="px-4 py-2 bg-gray-700/50 rounded-full text-gray-300">
                    {selectedProduct.website}
                  </span>
                  <a 
                    href={selectedProduct.product_link} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 rounded-full text-green-300 transition-all"
                  >
                    Ver Produto
                  </a>
                </div>
              </div>
              <div className="text-right">
                <div className="text-4xl font-bold text-white mb-2">
                  R$ {currentPrice.toFixed(2)}
                </div>
                <div className={`flex items-center justify-end space-x-2 ${priceChange >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  <span className="text-lg">
                    {priceChange >= 0 ? '↗' : '↘'}
                  </span>
                  <span className="font-semibold">
                    {priceChange >= 0 ? '+' : ''}R$ {priceChange.toFixed(2)} ({priceChangePercent}%)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Price Chart */}
          <div className="bg-gradient-to-br from-gray-800/50 to-gray-700/30 backdrop-blur-sm rounded-2xl p-8 border border-gray-700/50">
            <h3 className="text-xl font-semibold text-white mb-6 flex items-center space-x-2">
              <span>📈</span>
              <span>Variação de Preço</span>
            </h3>
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
                        backgroundColor: 'rgba(31, 41, 55, 0.95)',
                        border: '1px solid #374151',
                        borderRadius: '12px',
                        color: '#F3F4F6',
                        backdropFilter: 'blur(8px)'
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
      <header className="border-b border-gray-700/50 bg-gray-900/30 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg">
                <span className="text-white font-bold text-lg">PC</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                  PC Price Tracker
                </h1>
                <p className="text-gray-400 text-sm">Monitor inteligente de preços</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-6">
              {/* Navigation Tabs */}
              <nav className="flex bg-gray-800/50 backdrop-blur-sm rounded-xl p-1 border border-gray-700/50">
                <button
                  onClick={() => setActiveTab('dashboard')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    activeTab === 'dashboard' 
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg' 
                      : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
                  }`}
                >
                  📊 Dashboard
                </button>
                <button
                  onClick={() => setActiveTab('builds')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    activeTab === 'builds' 
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg' 
                      : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
                  }`}
                >
                  🖥️ Builds
                </button>
                <button
                  onClick={() => setActiveTab('products')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    activeTab === 'products' 
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg' 
                      : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
                  }`}
                >
                  📦 Produtos
                </button>
                {userRole === 'admin' && (
                  <button
                    onClick={() => setActiveTab('admin')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      activeTab === 'admin' 
                        ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg' 
                        : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
                    }`}
                  >
                    ⚙️ Admin
                  </button>
                )}
              </nav>
              
              <button
                onClick={() => {
                  supabase.auth.signOut();
                  setUserRole(null);
                }}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 rounded-xl font-medium transition-all backdrop-blur-sm"
              >
                Sair
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            <div className="text-center mb-8">
              <h2 className="text-4xl font-bold text-white mb-4">Dashboard Analytics</h2>
              <p className="text-gray-400 text-lg">Visão geral dos dados de preços e produtos</p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/20 backdrop-blur-sm rounded-2xl p-6 border border-blue-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-blue-300 text-sm font-medium">Total de Produtos</p>
                    <p className="text-3xl font-bold text-white">{dashboardStats.totalProducts}</p>
                  </div>
                  <div className="w-12 h-12 bg-blue-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">📦</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-green-500/20 to-green-600/20 backdrop-blur-sm rounded-2xl p-6 border border-green-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-green-300 text-sm font-medium">Builds Configuradas</p>
                    <p className="text-3xl font-bold text-white">{dashboardStats.totalBuilds}</p>
                  </div>
                  <div className="w-12 h-12 bg-green-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">🖥️</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/20 backdrop-blur-sm rounded-2xl p-6 border border-purple-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-purple-300 text-sm font-medium">Buscas Ativas</p>
                    <p className="text-3xl font-bold text-white">{dashboardStats.activeSearches}</p>
                  </div>
                  <div className="w-12 h-12 bg-purple-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">👁️</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-yellow-500/20 to-yellow-600/20 backdrop-blur-sm rounded-2xl p-6 border border-yellow-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-yellow-300 text-sm font-medium">Preço Médio</p>
                    <p className="text-3xl font-bold text-white">R$ {dashboardStats.avgPrice.toFixed(0)}</p>
                  </div>
                  <div className="w-12 h-12 bg-yellow-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">💰</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Price Distribution */}
              <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-gray-700/50">
                <h3 className="text-xl font-semibold text-white mb-6 flex items-center space-x-2">
                  <span>📊</span>
                  <span>Distribuição por Faixa de Preço</span>
                </h3>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboardStats.priceRanges}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis dataKey="range" stroke="#9CA3AF" />
                      <YAxis stroke="#9CA3AF" />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(31, 41, 55, 0.95)',
                          border: '1px solid #374151',
                          borderRadius: '12px',
                          color: '#F3F4F6'
                        }}
                      />
                      <Bar dataKey="count" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Category Distribution */}
              <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl p-8 border border-gray-700/50">
                <h3 className="text-xl font-semibold text-white mb-6 flex items-center space-x-2">
                  <span>🍰</span>
                  <span>Produtos por Categoria</span>
                </h3>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={dashboardStats.categoryDistribution}
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        fill="#8884d8"
                        dataKey="count"
                        label={({ category, count }) => `${category}: ${count}`}
                      >
                        {dashboardStats.categoryDistribution.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(31, 41, 55, 0.95)',
                          border: '1px solid #374151',
                          borderRadius: '12px',
                          color: '#F3F4F6'
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Builds Tab */}
        {activeTab === 'builds' && (
          <div className="space-y-8">
            {/* Builds Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-4xl font-bold text-white mb-2">Builds Configuradas</h2>
                <p className="text-gray-400 text-lg">Configurações completas de PC com preços atualizados</p>
              </div>
              {userRole === 'admin' && (
                <button
                  onClick={() => setShowBuildForm(!showBuildForm)}
                  className="flex items-center space-x-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white rounded-xl font-medium transition-all shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  <span className="text-xl">+</span>
                  <span>Nova Build</span>
                </button>
              )}
            </div>

            {/* Build Form */}
            {showBuildForm && userRole === 'admin' && (
              <div className="bg-gradient-to-r from-gray-800/50 to-gray-700/50 backdrop-blur-sm rounded-2xl p-8 border border-gray-700/50">
                <h3 className="text-2xl font-semibold text-white mb-6 flex items-center space-x-2">
                  <span>🛠️</span>
                  <span>Criar Nova Build</span>
                </h3>
                <div className="space-y-6">
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-2">
                      Nome da Build
                    </label>
                    <input
                      type="text"
                      value={newBuild.name}
                      onChange={(e) => setNewBuild({...newBuild, name: e.target.value})}
                      className="w-full px-4 py-3 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      placeholder="Ex: Gaming PC 2024"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-3">
                      Selecionar Categorias
                    </label>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {categories.map(category => (
                        <label key={category} className="flex items-center space-x-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={newBuild.categories.includes(category)}
                            onChange={() => toggleCategoryInBuild(category)}
                            className="w-5 h-5 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 transition-colors"
                          />
                          <span className="text-gray-300 group-hover:text-white transition-colors text-sm">
                            {category.replace('_', ' ').toUpperCase()}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flex space-x-4">
                    <button
                      onClick={createBuild}
                      className="px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-xl font-medium transition-all transform hover:scale-105"
                    >
                      Criar Build
                    </button>
                    <button
                      onClick={() => setShowBuildForm(false)}
                      className="px-6 py-3 bg-gray-600/50 hover:bg-gray-500/50 text-white rounded-xl font-medium transition-all backdrop-blur-sm"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Builds Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {builds.map(build => {
                const total = calculateBuildTotal(build.categories);
                return (
                  <div 
                    key={build.id} 
                    className="bg-gradient-to-br from-gray-800/50 to-gray-700/30 backdrop-blur-sm rounded-2xl p-6 border border-gray-700/50 hover:border-blue-500/50 transition-all group cursor-pointer transform hover:scale-105 hover:shadow-2xl"
                    onClick={() => setSelectedBuild(build)}
                  >
                    <div className="flex items-start justify-between mb-4">
                      <h3 className="text-xl font-semibold text-white group-hover:text-blue-400 transition-colors">
                        {build.name}
                      </h3>
                      {userRole === 'admin' && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteBuild(build.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 transition-all p-2 rounded-lg hover:bg-red-400/10"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                    
                    <div className="space-y-3 mb-6">
                      {build.categories.slice(0, 4).map(category => {
                        const categoryProducts = products.filter(p => p.category === category);
                        const lowestPrice = Math.min(...categoryProducts.map(p => p.price), 0);
                        return (
                          <div key={category} className="flex items-center justify-between">
                            <span className="text-gray-300 text-sm">
                              {category.replace('_', ' ').toUpperCase()}
                            </span>
                            {lowestPrice > 0 ? (
                              <span className="text-blue-400 font-medium text-sm">
                                R$ {lowestPrice.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-gray-500 text-sm">N/A</span>
                            )}
                          </div>
                        );
                      })}
                      {build.categories.length > 4 && (
                        <div className="text-gray-400 text-sm">
                          +{build.categories.length - 4} categorias
                        </div>
                      )}
                    </div>
                    
                    <div className="border-t border-gray-600/50 pt-4">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-300 font-medium">Total:</span>
                        <span className="text-2xl font-bold bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
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

        {/* Products Tab */}
        {activeTab === 'products' && (
          <div className="space-y-8">
            {/* Products Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-4xl font-bold text-white mb-2">Produtos Monitorados</h2>
                <p className="text-gray-400 text-lg">Todos os produtos com preços atualizados em tempo real</p>
              </div>
              
              {/* Search Bar */}
              <div className="flex items-center space-x-4">
                <div className="relative">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Buscar produtos..."
                    className="w-64 px-4 py-3 pl-10 bg-gray-800/50 backdrop-blur-sm border border-gray-600/50 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400">🔍</span>
                </div>
              </div>
            </div>

            {/* Filters and Sort */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-6 bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700/50">
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <span className="text-gray-400 text-sm">📂</span>
                  <select
                    value={filterCategory}
                    onChange={(e) => setFilterCategory(e.target.value)}
                    className="px-4 py-2 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-lg text-white focus:ring-2 focus:ring-blue-500 transition-all"
                  >
                    <option value="all">Todas as categorias</option>
                    {categories.map(category => (
                      <option key={category} value={category}>
                        {category.replace('_', ' ').toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              
              <div className="flex items-center space-x-4">
                <span className="text-gray-400 text-sm">Ordenar por:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-4 py-2 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-lg text-white focus:ring-2 focus:ring-blue-500 transition-all"
                >
                  <option value="name">Nome</option>
                  <option value="category">Categoria</option>
                  <option value="price">Preço</option>
                  <option value="website">Loja</option>
                </select>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="p-2 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg transition-all backdrop-blur-sm"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>

            {/* Products Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {getFilteredAndSortedProducts().map(product => (
                <div
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className="bg-gradient-to-br from-gray-800/50 to-gray-700/30 backdrop-blur-sm rounded-2xl p-6 border border-gray-700/50 hover:border-blue-500/50 cursor-pointer transition-all group hover:shadow-2xl hover:shadow-blue-500/10 transform hover:scale-105"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="px-3 py-1 bg-blue-500/20 border border-blue-500/30 rounded-full">
                      <span className="text-blue-300 text-xs font-medium">
                        {product.category.replace('_', ' ').toUpperCase()}
                      </span>
                    </div>
                    <div className="px-3 py-1 bg-gray-700/50 rounded-full">
                      <span className="text-gray-300 text-xs">{product.website}</span>
                    </div>
                  </div>
                  
                  <h3 className="text-white font-semibold mb-4 group-hover:text-blue-400 transition-colors line-clamp-2 h-12">
                    {product.name}
                  </h3>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-2xl font-bold bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
                      R$ {product.price.toFixed(2)}
                    </span>
                    <span className="text-gray-400 group-hover:text-blue-400 transition-colors text-xl">📊</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Admin Tab */}
        {activeTab === 'admin' && userRole === 'admin' && (
          <div className="space-y-8">
            {/* Admin Header */}
            <div className="text-center">
              <h2 className="text-4xl font-bold text-white mb-2">Painel Administrativo</h2>
              <p className="text-gray-400 text-lg">Gerencie configurações de busca e monitoramento</p>
            </div>

            {/* Quick Actions */}
            <div className="flex justify-center">
              <button
                onClick={() => setShowSearchForm(!showSearchForm)}
                className="flex items-center space-x-3 px-8 py-4 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white rounded-xl font-medium transition-all shadow-lg hover:shadow-xl transform hover:scale-105"
              >
                <span className="text-xl">+</span>
                <span>Nova Configuração de Busca</span>
              </button>
            </div>

            {/* Search Config Form */}
            {showSearchForm && (
              <div className="bg-gradient-to-r from-gray-800/50 to-gray-700/50 backdrop-blur-sm rounded-2xl p-8 border border-gray-700/50">
                <h3 className="text-2xl font-semibold text-white mb-6 flex items-center space-x-2">
                  <span>🔍</span>
                  <span>Adicionar Nova Busca</span>
                </h3>
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-gray-300 text-sm font-medium mb-2">Termo de Busca</label>
                      <input
                        type="text"
                        value={newSearch.search_text}
                        onChange={(e) => setNewSearch({...newSearch, search_text: e.target.value})}
                        className="w-full px-4 py-3 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                        placeholder="Ex: ryzen 5 5600x"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-300 text-sm font-medium mb-2">Categoria</label>
                      <input
                        type="text"
                        value={newSearch.category}
                        onChange={(e) => setNewSearch({...newSearch, category: e.target.value})}
                        className="w-full px-4 py-3 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                        placeholder="Ex: cpu"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-3">Grupos de Palavras-chave</label>
                    {newSearch.keywordGroups.map((group, index) => (
                      <div key={index} className="flex gap-3 mb-3">
                        <input 
                          type="text" 
                          value={group}
                          onChange={(e) => updateKeywordGroup(index, e.target.value)}
                          className="flex-1 px-4 py-3 bg-gray-700/50 backdrop-blur-sm border border-gray-600/50 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                          placeholder="Ex: x3d,5500,processador"
                        />
                        {newSearch.keywordGroups.length > 1 && (
                          <button 
                            type="button" 
                            onClick={() => removeKeywordGroup(index)}
                            className="px-4 py-3 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 rounded-xl transition-all"
                          >
                            Remover
                          </button>
                        )}
                      </div>
                    ))}
                    <button 
                      type="button" 
                      onClick={addKeywordGroup}
                      className="px-6 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 rounded-xl transition-all"
                    >
                      + Adicionar Grupo
                    </button>
                    <p className="text-gray-400 text-sm mt-2">
                      Cada grupo deve conter palavras-chave separadas por vírgula. Todas as palavras de um grupo devem estar presentes no produto.
                    </p>
                  </div>

                  <div>
                    <label className="block text-gray-300 text-sm font-medium mb-3">Websites</label>
                    <div className="grid grid-cols-3 gap-4">
                      {Object.keys(newSearch.websites).map(website => (
                        <label key={website} className="flex items-center space-x-3 cursor-pointer group">
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
                            className="w-5 h-5 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 transition-colors"
                          />
                          <span className="text-gray-300 group-hover:text-white transition-colors capitalize">
                            {website}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center space-x-3">
                    <input 
                      type="checkbox" 
                      id="is_active"
                      checked={newSearch.is_active}
                      onChange={(e) => setNewSearch({...newSearch, is_active: e.target.checked})}
                      className="w-5 h-5 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 transition-colors"
                    />
                    <label htmlFor="is_active" className="text-gray-300 cursor-pointer">Busca Ativa</label>
                  </div>

                  <div className="flex space-x-4">
                    <button 
                      onClick={addSearchConfig} 
                      className="px-8 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-xl font-medium transition-all transform hover:scale-105"
                    >
                      Adicionar Busca
                    </button>
                    <button
                      onClick={() => setShowSearchForm(false)}
                      className="px-8 py-3 bg-gray-600/50 hover:bg-gray-500/50 text-white rounded-xl font-medium transition-all backdrop-blur-sm"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Search Configs Table */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700/50 overflow-hidden">
              <div className="p-6 border-b border-gray-700/50">
                <h3 className="text-xl font-semibold text-white flex items-center space-x-2">
                  <span>⚙️</span>
                  <span>Configurações Ativas</span>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-900/50">
                    <tr>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Termo</th>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Grupos</th>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Categoria</th>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Website</th>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Status</th>
                      <th className="text-left py-4 px-6 text-gray-300 font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchConfigs.map(config => (
                      <tr key={config.id} className="border-b border-gray-700/30 hover:bg-gray-700/20 transition-colors">
                        <td className="py-4 px-6">
                          <div className="text-white font-medium">{config.search_text}</div>
                        </td>
                        <td className="py-4 px-6">
                          <div className="flex flex-col gap-1">
                            {config.keywordGroups?.map((group, groupIdx) => (
                              <div key={groupIdx} className="bg-gray-700/50 px-2 py-1 rounded text-xs text-gray-300 inline-block">
                                {group}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <span className="px-3 py-1 bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs rounded-full font-medium">
                            {config.category.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-4 px-6">
                          <span className="text-gray-300 capitalize">{config.website}</span>
                        </td>
                        <td className="py-4 px-6">
                          <button
                            onClick={() => toggleSearchActive(config.id, config.is_active)}
                            className={`flex items-center space-x-2 px-3 py-1 rounded-full text-sm font-medium transition-all ${
                              config.is_active 
                                ? 'bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 text-green-300' 
                                : 'bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300'
                            }`}
                          >
                            <span>{config.is_active ? '✅' : '❌'}</span>
                            <span>{config.is_active ? 'Ativo' : 'Inativo'}</span>
                          </button>
                        </td>
                        <td className="py-4 px-6">
                          <button
                            onClick={() => deleteSearchConfig(config.id)}
                            className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
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

            {/* Admin Statistics */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/20 backdrop-blur-sm rounded-2xl p-6 border border-blue-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-blue-300 text-sm font-medium">Total de Produtos</p>
                    <p className="text-3xl font-bold text-white">{products.length}</p>
                  </div>
                  <div className="w-12 h-12 bg-blue-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">📦</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-green-500/20 to-green-600/20 backdrop-blur-sm rounded-2xl p-6 border border-green-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-green-300 text-sm font-medium">Builds Configuradas</p>
                    <p className="text-3xl font-bold text-white">{builds.length}</p>
                  </div>
                  <div className="w-12 h-12 bg-green-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">🖥️</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/20 backdrop-blur-sm rounded-2xl p-6 border border-purple-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-purple-300 text-sm font-medium">Buscas Ativas</p>
                    <p className="text-3xl font-bold text-white">
                      {searchConfigs.filter(c => c.is_active).length}
                    </p>
                  </div>
                  <div className="w-12 h-12 bg-purple-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">👁️</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-gradient-to-br from-yellow-500/20 to-yellow-600/20 backdrop-blur-sm rounded-2xl p-6 border border-yellow-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-yellow-300 text-sm font-medium">Configurações Total</p>
                    <p className="text-3xl font-bold text-white">{searchConfigs.length}</p>
                  </div>
                  <div className="w-12 h-12 bg-yellow-500/30 rounded-xl flex items-center justify-center">
                    <span className="text-2xl">⚙️</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Global Styles */}
      <style jsx global>{`
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
        
        /* Scrollbar Styling */
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        
        ::-webkit-scrollbar-track {
          background: rgba(75, 85, 99, 0.3);
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb {
          background: rgba(59, 130, 246, 0.6);
          border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(59, 130, 246, 0.8);
        }
        
        /* Custom animations */
        @keyframes slideInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-slideInUp {
          animation: slideInUp 0.3s ease-out;
        }
        
        /* Smooth focus transitions */
        input:focus,
        select:focus,
        textarea:focus {
          outline: none;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        
        /* Improved button hover effects */
        button {
          position: relative;
          overflow: hidden;
        }
        
        button::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
          transition: left 0.5s;
        }
        
        button:hover::before {
          left: 100%;
        }
        
        /* Glass effect for cards */
        .glass {
          background: rgba(31, 41, 55, 0.3);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        /* Loading skeleton */
        .skeleton {
          background: linear-gradient(90deg, #374151 25%, #4B5563 50%, #374151 75%);
          background-size: 200% 100%;
          animation: loading 2s infinite;
        }
        
        @keyframes loading {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        
        /* Responsive table */
        @media (max-width: 768px) {
          table, thead, tbody, th, td, tr {
            display: block;
          }
          
          thead tr {
            position: absolute;
            top: -9999px;
            left: -9999px;
          }
          
          tr {
            border: 1px solid rgba(75, 85, 99, 0.3);
            margin-bottom: 1rem;
            border-radius: 8px;
            padding: 1rem;
            background: rgba(31, 41, 55, 0.3);
          }
          
          td {
            border: none;
            position: relative;
            padding: 0.5rem 0;
          }
          
          td:before {
            content: attr(data-label) ": ";
            font-weight: bold;
            color: #9CA3AF;
          }
        }
        
        /* Enhanced hover effects */
        .hover-lift {
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .hover-lift:hover {
          transform: translateY(-4px);
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        }
        
        /* Gradient borders */
        .gradient-border {
          position: relative;
          background: linear-gradient(45deg, #1F2937, #374151);
        }
        
        .gradient-border::before {
          content: '';
          position: absolute;
          inset: 0;
          padding: 1px;
          background: linear-gradient(45deg, #3B82F6, #8B5CF6, #F59E0B);
          border-radius: inherit;
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask-composite: exclude;
        }
        
        /* Improved text selection */
        ::selection {
          background-color: rgba(59, 130, 246, 0.3);
          color: white;
        }
        
        ::-moz-selection {
          background-color: rgba(59, 130, 246, 0.3);
          color: white;
        }
        
        /* Enhanced focus indicators for accessibility */
        .focus\:ring-2:focus {
          outline: 2px solid transparent;
          outline-offset: 2px;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5);
        }
        
        /* Smooth page transitions */
        .page-transition {
          animation: fadeIn 0.3s ease-in-out;
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}