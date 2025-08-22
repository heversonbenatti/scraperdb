import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

export default function Home() {
  const [userRole, setUserRole] = useState('guest');
  const [showLogin, setShowLogin] = useState(false);
  const [builds, setBuilds] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchConfigs, setSearchConfigs] = useState([]);
  const [activeTab, setActiveTab] = useState('home');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [sortBy, setSortBy] = useState('price');
  const [sortOrder, setSortOrder] = useState('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedWebsites, setSelectedWebsites] = useState([]);
  const [topDrops, setTopDrops] = useState([]);
  const [expandedBuildProduct, setExpandedBuildProduct] = useState(null);
  const [buildProductModal, setBuildProductModal] = useState(null);
  const [configFilters, setConfigFilters] = useState({ category: '', website: '' });
  const [chartInterval, setChartInterval] = useState('6h');

  const [newBuild, setNewBuild] = useState({
    name: '',
    categories: [],
    auto_refresh: true,
    product_overrides: {}
  });

  const [newSearch, setNewSearch] = useState({
    search_text: '',
    keywordGroups: [''],
    category: '',
    websites: { kabum: false, pichau: false, terabyte: false },
    is_active: true
  });

  const [loginCreds, setLoginCreds] = useState({ email: '', password: '' });

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session) setUserRole('admin');
      await fetchInitialData();
    };

    const fetchInitialData = async () => {
      try {
        const { data: buildsData } = await supabaseClient
          .from('builds')
          .select('*')
          .order('created_at', { ascending: false });
        setBuilds(buildsData || []);

        const { data: productsData } = await supabaseClient
          .from('products')
          .select('id, name, category, website, product_link');

        const productsWithPrices = await Promise.all(
          (productsData || []).map(async (product) => {
            // Get the last two distinct prices to calculate price change
            const { data: pricesData } = await supabaseClient
              .from('prices')
              .select('price, collected_at, price_changed_at, last_checked_at')
              .eq('product_id', product.id)
              .order('price_changed_at', { ascending: false })
              .limit(2);

            const currentPrice = pricesData?.[0]?.price || 0;
            const previousPrice = pricesData?.[1]?.price || currentPrice;
            const priceChange = previousPrice > 0 ? ((currentPrice - previousPrice) / previousPrice * 100) : 0;

            return {
              ...product,
              currentPrice,
              previousPrice,
              priceChange,
              lastUpdated: pricesData?.[0]?.last_checked_at || pricesData?.[0]?.collected_at
            };
          })
        );

        setProducts(productsWithPrices.filter(p => p.currentPrice > 0));

        const drops = productsWithPrices
          .filter(p => p.priceChange < 0 && p.currentPrice > 0)
          .sort((a, b) => a.priceChange - b.priceChange)
          .slice(0, 10);
        setTopDrops(drops);

        await fetchSearchConfigs();
        setLoading(false);
      } catch (error) {
        console.error('Error fetching data:', error);
        setLoading(false);
      }
    };

    const fetchSearchConfigs = async () => {
      try {
        const { data: configsData } = await supabaseClient
          .from('search_configs')
          .select('*')
          .order('created_at', { ascending: false });

        const configsWithKeywords = await Promise.all(
          (configsData || []).map(async (config) => {
            const { data: keywordData } = await supabaseClient
              .from('keyword_groups')
              .select('keywords')
              .eq('search_config_id', config.id);

            return {
              ...config,
              keywordGroups: keywordData?.map(kg => kg.keywords) || []
            };
          })
        );

        setSearchConfigs(configsWithKeywords);
      } catch (error) {
        console.error('Error fetching configs:', error);
      }
    };

    checkSession();

    const pricesSubscription = supabaseClient
      .channel('price-changes')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'prices'
      }, payload => {
        setProducts(prev => prev.map(product =>
          product.id === payload.new.product_id
            ? { ...product, currentPrice: payload.new.price, lastUpdated: payload.new.last_checked_at || payload.new.collected_at }
            : product
        ));
      })
      .subscribe();

    return () => {
      supabaseClient.removeChannel(pricesSubscription);
    };
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

  const fetchPriceHistory = async (productId, interval = '6h') => {
    try {
      let hours, limit;

      // Definir período e limite baseado no intervalo
      switch (interval) {
        case '1h': // Últimas 24 horas, pontos de 1 em 1 hora
          hours = 24;
          limit = 24;
          break;
        case '6h': // Últimos 6 dias, pontos de 6 em 6 horas  
          hours = 144; // 6 dias * 24 horas
          limit = 24; // 6 dias / 6 horas = 24 pontos
          break;
        case '1d': // Últimos 30 dias, pontos de 1 em 1 dia
          hours = 720; // 30 dias * 24 horas
          limit = 30;
          break;
        case '1w': // Últimos 3 meses, pontos de 1 em 1 semana
          hours = 2160; // 90 dias * 24 horas
          limit = 12; // 3 meses / 1 semana ≈ 12 pontos
          break;
        default:
          hours = 144;
          limit = 24;
      }

      const startDate = new Date();
      startDate.setHours(startDate.getHours() - hours);

      const { data } = await supabaseClient
        .from('prices')
        .select('price, collected_at, price_changed_at')
        .eq('product_id', productId)
        .gte('price_changed_at', startDate.toISOString())
        .order('price_changed_at', { ascending: true })
        .limit(limit);

      setPriceHistory(data || []);
    } catch (error) {
      console.error('Error fetching price history:', error);
      setPriceHistory([]);
    }
  };

  const showPriceModal = async (product) => {
    setSelectedProduct(product);
    setChartInterval('6h'); // Reset para padrão
    await fetchPriceHistory(product.id, '6h');
  };

  const handleIntervalChange = async (newInterval) => {
    setChartInterval(newInterval);
    if (selectedProduct) {
      await fetchPriceHistory(selectedProduct.id, newInterval);
    }
  };

  const getSortedProducts = useMemo(() => {
    let sorted = [...products];

    if (searchTerm) {
      sorted = sorted.filter(p =>
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.category.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (selectedCategories.length > 0) {
      sorted = sorted.filter(p => selectedCategories.includes(p.category));
    }

    if (selectedWebsites.length > 0) {
      sorted = sorted.filter(p => selectedWebsites.includes(p.website));
    }

    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'price') {
        comparison = a.currentPrice - b.currentPrice;
      } else if (sortBy === 'category') {
        comparison = a.category.localeCompare(b.category);
      } else if (sortBy === 'drop') {
        comparison = a.priceChange - b.priceChange;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [products, searchTerm, selectedCategories, selectedWebsites, sortBy, sortOrder]);

  const calculateBuildTotal = (build) => {
    if (!build.categories || !products.length) return 0;

    return build.categories.reduce((total, category) => {
      if (build.product_overrides?.[category]) {
        const overrideProduct = products.find(p => p.id === build.product_overrides[category]);
        return total + (overrideProduct?.currentPrice || 0);
      }
      const lowestInCategory = products
        .filter(p => p.category === category)
        .sort((a, b) => a.currentPrice - b.currentPrice)[0];
      return total + (lowestInCategory?.currentPrice || 0);
    }, 0);
  };

  const getBuildProduct = (build, category) => {
    if (build.product_overrides?.[category]) {
      return products.find(p => p.id === build.product_overrides[category]);
    }
    return products
      .filter(p => p.category === category)
      .sort((a, b) => a.currentPrice - b.currentPrice)[0];
  };

  const updateBuildProduct = async (buildId, category, productId) => {
    const build = builds.find(b => b.id === buildId);
    const newOverrides = { ...build.product_overrides, [category]: productId };

    await supabaseClient
      .from('builds')
      .update({
        product_overrides: newOverrides,
        auto_refresh: false
      })
      .eq('id', buildId);

    setBuilds(prev => prev.map(b =>
      b.id === buildId
        ? { ...b, product_overrides: newOverrides, auto_refresh: false }
        : b
    ));
    setBuildProductModal(null);
  };

  const toggleBuildAutoRefresh = async (buildId, value) => {
    const updateData = value
      ? { auto_refresh: true, product_overrides: {} }
      : { auto_refresh: false };

    await supabaseClient
      .from('builds')
      .update(updateData)
      .eq('id', buildId);

    setBuilds(prev =>
      prev.map(b =>
        b.id === buildId
          ? { ...b, ...updateData }
          : b
      )
    );
  };

  const createBuild = async () => {
    if (!newBuild.name || newBuild.categories.length === 0) return;

    const { error } = await supabaseClient
      .from('builds')
      .insert([newBuild]);

    if (!error) {
      setNewBuild({ name: '', categories: [], auto_refresh: true, product_overrides: {} });
      window.location.reload();
    }
  };

  const deleteBuild = async (id) => {
    if (confirm('Remover esta build?')) {
      await supabaseClient.from('builds').delete().eq('id', id);
      setBuilds(prev => prev.filter(b => b.id !== id));
    }
  };

  const addSearchConfig = async () => {
    if (!newSearch.search_text || !newSearch.category) return;

    const validKeywordGroups = newSearch.keywordGroups.filter(g => g.trim());
    if (validKeywordGroups.length === 0) return;

    const selectedWebsites = Object.entries(newSearch.websites)
      .filter(([_, checked]) => checked)
      .map(([site]) => site);

    if (selectedWebsites.length === 0) return;

    try {
      for (const website of selectedWebsites) {
        const { data: configData } = await supabaseClient
          .from('search_configs')
          .insert([{
            search_text: newSearch.search_text,
            category: newSearch.category,
            website: website,
            is_active: newSearch.is_active
          }])
          .select();

        const keywordGroupsData = validKeywordGroups.map(group => ({
          search_config_id: configData[0].id,
          keywords: group
        }));

        await supabaseClient.from('keyword_groups').insert(keywordGroupsData);
      }

      setNewSearch({
        search_text: '',
        keywordGroups: [''],
        category: '',
        websites: { kabum: false, pichau: false, terabyte: false },
        is_active: true
      });
      window.location.reload();
    } catch (error) {
      console.error('Error adding config:', error);
    }
  };

  const toggleSearchActive = async (id, currentStatus) => {
    await supabaseClient
      .from('search_configs')
      .update({ is_active: !currentStatus })
      .eq('id', id);

    setSearchConfigs(prev => prev.map(config =>
      config.id === id ? { ...config, is_active: !currentStatus } : config
    ));
  };

  const deleteSearchConfig = async (id) => {
    if (confirm('Remover esta configuração?')) {
      await supabaseClient.from('search_configs').delete().eq('id', id);
      setSearchConfigs(prev => prev.filter(c => c.id !== id));
    }
  };

  const getFilteredConfigs = useMemo(() => {
    let filtered = [...searchConfigs];
    if (configFilters.category) {
      filtered = filtered.filter(c => c.category === configFilters.category);
    }
    if (configFilters.website) {
      filtered = filtered.filter(c => c.website === configFilters.website);
    }
    return filtered;
  }, [searchConfigs, configFilters]);

  const allCategories = useMemo(() =>
    [...new Set(products.map(p => p.category))].sort(),
    [products]
  );

  const allWebsites = useMemo(() =>
    [...new Set(products.map(p => p.website))].sort(),
    [products]
  );

  // Componente do gráfico melhorado
  const PriceChart = ({ data, className = "" }) => {
    if (!data || data.length === 0) {
      return (
        <div className={`flex items-center justify-center h-48 text-gray-400 ${className}`}>
          Sem dados de histórico disponíveis
        </div>
      );
    }

    const maxPrice = Math.max(...data.map(d => d.price));
    const minPrice = Math.min(...data.map(d => d.price));
    const priceRange = maxPrice - minPrice;

    // Se o range for muito pequeno (menos de 1% do preço máximo), força um range mínimo
    const minRangePercent = 0.02; // 2% mínimo
    const actualRange = priceRange < maxPrice * minRangePercent ? maxPrice * minRangePercent : priceRange;
    
    // Calcula padding baseado no range real ou mínimo
    const padding = actualRange * 0.1; // 10% de padding
    const paddedMin = minPrice - padding;
    const paddedMax = maxPrice + padding;
    const paddedRange = paddedMax - paddedMin;

    const getY = (price) => 200 - ((price - paddedMin) / paddedRange) * 180;
    const getX = (index) => (index / (data.length - 1)) * 380 + 10;

    // Criar path para linha curva
    const createPath = () => {
      if (data.length === 1) {
        const x = getX(0);
        const y = getY(data[0].price);
        return `M ${x} ${y} L ${x + 1} ${y}`;
      }

      let path = `M ${getX(0)} ${getY(data[0].price)}`;

      for (let i = 1; i < data.length; i++) {
        const x = getX(i);
        const y = getY(data[i].price);
        const prevX = getX(i - 1);
        const prevY = getY(data[i - 1].price);

        // Criar curva suave usando quadratic bezier
        const cpx = prevX + (x - prevX) / 2;
        path += ` Q ${cpx} ${prevY} ${x} ${y}`;
      }

      return path;
    };

    // Criar área sob a curva
    const createAreaPath = () => {
      if (data.length === 0) return '';

      let path = `M ${getX(0)} 200 L ${getX(0)} ${getY(data[0].price)}`;

      for (let i = 1; i < data.length; i++) {
        const x = getX(i);
        const y = getY(data[i].price);
        const prevX = getX(i - 1);
        const prevY = getY(data[i - 1].price);

        const cpx = prevX + (x - prevX) / 2;
        path += ` Q ${cpx} ${prevY} ${x} ${y}`;
      }

      path += ` L ${getX(data.length - 1)} 200 Z`;
      return path;
    };

    return (
      <div className={`bg-gray-700 rounded-lg p-4 ${className}`}>
        <svg width="100%" height="240" viewBox="0 0 400 240" className="overflow-visible">
          <defs>
            <linearGradient id="priceGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgb(147, 51, 234)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="rgb(147, 51, 234)" stopOpacity={0.05} />
            </linearGradient>
            <filter id="glow">
              <feMorphology operator="dilate" radius="1" />
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Grid lines */}
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgb(75, 85, 99)" strokeWidth="0.5" opacity="0.3" />
            </pattern>
          </defs>
          <rect width="100%" height="200" fill="url(#grid)" />

          {/* Área sob a curva */}
          <path
            d={createAreaPath()}
            fill="url(#priceGradient)"
          />

          {/* Linha principal */}
          <path
            d={createPath()}
            fill="none"
            stroke="rgb(147, 51, 234)"
            strokeWidth="3"
            filter="url(#glow)"
            className="drop-shadow-lg"
          />

          {/* Pontos de dados */}
          {data.map((entry, idx) => {
            const x = getX(idx);
            const y = getY(entry.price);
            return (
              <g key={idx}>
                <circle
                  cx={x}
                  cy={y}
                  r="4"
                  fill="rgb(147, 51, 234)"
                  stroke="white"
                  strokeWidth="2"
                  className="hover:r-6 transition-all duration-200 cursor-pointer"
                  style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' }}
                >
                  <title>
                    R$ {entry.price.toFixed(2)} - {new Date(entry.price_changed_at || entry.collected_at).toLocaleDateString('pt-BR')}
                  </title>
                </circle>
              </g>
            );
          })}
        </svg>

        {/* Estatísticas */}
        <div className="grid grid-cols-3 gap-4 mt-4 text-center text-sm">
          <div>
            <p className="text-gray-400">Menor</p>
            <p className="text-lg font-bold text-green-400">
              R$ {minPrice.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-gray-400">Atual</p>
            <p className="text-lg font-bold text-purple-400">
              R$ {data[data.length - 1]?.price.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-gray-400">Maior</p>
            <p className="text-lg font-bold text-red-400">
              R$ {maxPrice.toFixed(2)}
            </p>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-8">
              <h1 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                🖥️ PC Scraper
              </h1>
              <nav className="hidden md:flex space-x-4">
                {['home', 'builds', 'products', ...(userRole === 'admin' ? ['admin'] : [])].map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === tab
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                      }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </nav>
            </div>
            <div className="flex items-center space-x-4">
              {userRole === 'admin' ? (
                <button
                  onClick={handleLogout}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-md text-sm font-medium transition-colors"
                >
                  Sair
                </button>
              ) : (
                <button
                  onClick={() => setShowLogin(true)}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md text-sm font-medium transition-colors"
                >
                  Login Admin
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'home' && (
          <div className="space-y-8 animate-fade-in">
            <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
              <h2 className="text-2xl font-bold mb-6 flex items-center">
                <span className="mr-2">📉</span> Maiores Quedas de Preço (24h)
              </h2>
              <div className="space-y-3">
                {topDrops.map((product, idx) => (
                  <div key={product.id} className="bg-gray-700 rounded-lg p-4">
                    <div className="flex items-center justify-between hover:bg-gray-600 transition-colors rounded-lg p-2">
                      <div className="flex items-center space-x-4">
                        <span className="text-2xl font-bold text-gray-400">#{idx + 1}</span>
                        <div>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-sm text-gray-400">{product.category} • {product.website}</p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <p className="text-lg font-bold text-green-400">R$ {product.currentPrice.toFixed(2)}</p>
                          <p className="text-sm text-gray-400 line-through">R$ {product.previousPrice.toFixed(2)}</p>
                        </div>
                        <div className="bg-green-600 px-3 py-1 rounded-full">
                          <span className="font-bold">{product.priceChange.toFixed(1)}%</span>
                        </div>
                        <button
                          onClick={() => showPriceModal(product)}
                          className="text-gray-400 hover:text-white transition-colors"
                          title="Ver gráfico de preços"
                        >
                          📊
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'builds' && (
          <div className="space-y-6 animate-fade-in">
            {userRole === 'admin' && (
              <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
                <h3 className="text-lg font-bold mb-4">Nova Build</h3>
                <div className="space-y-4">
                  <input
                    type="text"
                    placeholder="Nome da Build"
                    value={newBuild.name}
                    onChange={(e) => setNewBuild({ ...newBuild, name: e.target.value })}
                    className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {allCategories.map(category => (
                      <label key={category} className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newBuild.categories.includes(category)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewBuild({ ...newBuild, categories: [...newBuild.categories, category] });
                            } else {
                              setNewBuild({ ...newBuild, categories: newBuild.categories.filter(c => c !== category) });
                            }
                          }}
                          className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 rounded focus:ring-purple-500"
                        />
                        <span className="text-sm">{category.replace('_', ' ').toUpperCase()}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={createBuild}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors"
                  >
                    Criar Build
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {builds.map(build => (
                <div key={build.id} className="bg-gray-800 rounded-lg p-6 border border-gray-700">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold">{build.name}</h3>
                    <div className="flex items-center space-x-2">
                      <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={build.auto_refresh !== false}
                          onChange={(e) => toggleBuildAutoRefresh(build.id, e.target.checked)}
                          className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 rounded"
                        />
                        <span className="text-sm">Auto</span>
                      </label>
                      {userRole === 'admin' && (
                        <button
                          onClick={() => deleteBuild(build.id)}
                          className="text-red-400 hover:text-red-300"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {build.categories.map(category => {
                      const product = getBuildProduct(build, category);
                      const isOverride = build.product_overrides?.[category];

                      return product ? (
                        <div key={category} className="bg-gray-700 rounded p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className="text-xs text-gray-400 uppercase">{category.replace('_', ' ')}</p>
                              <p className="text-sm font-medium truncate max-w-[200px]">{product.name}</p>
                              <p className="text-xs text-gray-500 capitalize">{product.website}</p>
                            </div>
                            <div className="flex items-center space-x-2">
                              <span className="font-bold text-purple-400">R$ {product.currentPrice.toFixed(2)}</span>
                              {isOverride && <span className="text-xs text-yellow-400">✏️</span>}

                              {/* Botão de gráfico */}
                              <button
                                onClick={() => showPriceModal(product)}
                                className="text-gray-400 hover:text-white transition-colors"
                                title="Ver gráfico de preços"
                              >
                                📊
                              </button>

                              {/* Botão de URL */}
                              <a
                                href={product.product_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-400 hover:text-white transition-colors"
                                title="Ver no site"
                              >
                                🔗
                              </a>

                              {/* Botão de configuração */}
                              <button
                                onClick={() => setBuildProductModal({ buildId: build.id, category, currentProduct: product })}
                                className="text-gray-400 hover:text-white transition-colors"
                                title="Trocar produto"
                              >
                                ⚙️
                              </button>
                            </div>
                          </div>

                          {/* Mostrar mudança de preço se disponível */}
                          {product.priceChange !== 0 && (
                            <div className="mt-2 flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                <span className="text-xs text-gray-400">Variação 24h:</span>
                                <span className={`text-xs font-medium ${product.priceChange < 0 ? 'text-green-400' : 'text-red-400'}`}>
                                  {product.priceChange > 0 ? '+' : ''}{product.priceChange.toFixed(1)}%
                                </span>
                              </div>
                              {product.previousPrice && product.previousPrice !== product.currentPrice && (
                                <span className="text-xs text-gray-500 line-through">
                                  R$ {product.previousPrice.toFixed(2)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div key={category} className="bg-gray-700 rounded p-3 border-2 border-dashed border-gray-600">
                          <p className="text-xs text-gray-400 uppercase">{category.replace('_', ' ')}</p>
                          <p className="text-sm text-gray-500 italic">Nenhum produto encontrado</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-4 border-t border-gray-600">
                    <div className="flex items-center justify-between">
                      <p className="text-xl font-bold text-purple-400">
                        Total: R$ {calculateBuildTotal(build).toFixed(2)}
                      </p>
                      <div className="text-right text-xs text-gray-400">
                        {build.categories.length} componente(s)
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'products' && (
          <div className="space-y-6 animate-fade-in">
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <div className="flex flex-wrap gap-4">
                <input
                  type="text"
                  placeholder="Buscar produtos..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="flex-1 min-w-[200px] px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="price">Preço</option>
                  <option value="category">Categoria</option>
                  <option value="drop">Maior Queda %</option>
                </select>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-md transition-colors"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Filtro por categoria */}
                <div>
                  <p className="text-sm text-gray-400 mb-2">Filtrar por categoria:</p>
                  <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                    {allCategories.map(category => (
                      <label key={category} className="flex items-center space-x-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedCategories.includes(category)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedCategories([...selectedCategories, category]);
                            } else {
                              setSelectedCategories(selectedCategories.filter(c => c !== category));
                            }
                          }}
                          className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 rounded"
                        />
                        <span className="text-xs">{category.replace('_', ' ').toUpperCase()}</span>
                      </label>
                    ))}
                  </div>
                  {selectedCategories.length > 0 && (
                    <button
                      onClick={() => setSelectedCategories([])}
                      className="text-xs text-purple-400 hover:text-purple-300 mt-2"
                    >
                      Limpar categorias
                    </button>
                  )}
                </div>

                {/* Filtro por website */}
                <div>
                  <p className="text-sm text-gray-400 mb-2">Filtrar por website:</p>
                  <div className="flex flex-wrap gap-2">
                    {allWebsites.map(website => (
                      <label key={website} className="flex items-center space-x-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedWebsites.includes(website)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedWebsites([...selectedWebsites, website]);
                            } else {
                              setSelectedWebsites(selectedWebsites.filter(w => w !== website));
                            }
                          }}
                          className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded"
                        />
                        <span className="text-xs capitalize">{website}</span>
                      </label>
                    ))}
                  </div>
                  {selectedWebsites.length > 0 && (
                    <button
                      onClick={() => setSelectedWebsites([])}
                      className="text-xs text-blue-400 hover:text-blue-300 mt-2"
                    >
                      Limpar websites
                    </button>
                  )}
                </div>
              </div>

              {/* Resumo dos filtros */}
              {(selectedCategories.length > 0 || selectedWebsites.length > 0 || searchTerm) && (
                <div className="mt-4 p-3 bg-gray-700 rounded-md">
                  <p className="text-sm text-gray-300">
                    Mostrando {getSortedProducts.length} produto(s)
                    {searchTerm && ` com "${searchTerm}"`}
                    {selectedCategories.length > 0 && ` em ${selectedCategories.length} categoria(s)`}
                    {selectedWebsites.length > 0 && ` de ${selectedWebsites.length} website(s)`}
                  </p>
                  <button
                    onClick={() => {
                      setSearchTerm('');
                      setSelectedCategories([]);
                      setSelectedWebsites([]);
                    }}
                    className="text-xs text-red-400 hover:text-red-300 mt-1"
                  >
                    Limpar todos os filtros
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {getSortedProducts.map(product => (
                <div key={product.id} className="bg-gray-800 rounded-lg p-4 border border-gray-700 hover:border-purple-500 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-xs bg-purple-600 px-2 py-1 rounded">
                      {product.category.replace('_', ' ').toUpperCase()}
                    </span>
                    <span className="text-xs text-gray-400 capitalize">{product.website}</span>
                  </div>
                  <h4 className="text-sm font-medium mb-3 line-clamp-2 max-w-[220px] truncate">{product.name}</h4>
                  <div className="flex justify-between items-end">
                    <div>
                      <p className="text-xl font-bold text-purple-400">R$ {product.currentPrice.toFixed(2)}</p>
                      {product.priceChange !== 0 && (
                        <p className={`text-xs ${product.priceChange < 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {product.priceChange.toFixed(1)}%
                        </p>
                      )}
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => showPriceModal(product)}
                        className="text-gray-400 hover:text-white"
                      >
                        📊
                      </button>
                      <a
                        href={product.product_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-white"
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

        {activeTab === 'admin' && userRole === 'admin' && (
          <div className="space-y-6 animate-fade-in">
            <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
              <h3 className="text-lg font-bold mb-4">Nova Configuração de Busca</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <input
                  type="text"
                  placeholder="Termo de busca"
                  value={newSearch.search_text}
                  onChange={(e) => setNewSearch({ ...newSearch, search_text: e.target.value })}
                  className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <input
                  type="text"
                  placeholder="Categoria"
                  value={newSearch.category}
                  onChange={(e) => setNewSearch({ ...newSearch, category: e.target.value })}
                  className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div className="space-y-2 mb-4">
                <p className="text-sm text-gray-400">Palavras-chave (separadas por vírgula):</p>
                {newSearch.keywordGroups.map((group, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      type="text"
                      placeholder="ex: x3d,5500,processador"
                      value={group}
                      onChange={(e) => {
                        const updated = [...newSearch.keywordGroups];
                        updated[idx] = e.target.value;
                        setNewSearch({ ...newSearch, keywordGroups: updated });
                      }}
                      className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    {newSearch.keywordGroups.length > 1 && (
                      <button
                        onClick={() => {
                          setNewSearch({
                            ...newSearch,
                            keywordGroups: newSearch.keywordGroups.filter((_, i) => i !== idx)
                          });
                        }}
                        className="px-3 py-2 bg-red-600 hover:bg-red-700 rounded-md transition-colors"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setNewSearch({ ...newSearch, keywordGroups: [...newSearch.keywordGroups, ''] })}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-md transition-colors"
                >
                  + Adicionar Grupo
                </button>
              </div>
              <div className="flex gap-4 mb-4">
                {Object.keys(newSearch.websites).map(site => (
                  <label key={site} className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newSearch.websites[site]}
                      onChange={(e) => setNewSearch({
                        ...newSearch,
                        websites: { ...newSearch.websites, [site]: e.target.checked }
                      })}
                      className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 rounded"
                    />
                    <span className="text-sm">{site.charAt(0).toUpperCase() + site.slice(1)}</span>
                  </label>
                ))}
              </div>
              <button
                onClick={addSearchConfig}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors"
              >
                Adicionar Configuração
              </button>
            </div>

            <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
              <h3 className="text-lg font-bold mb-4">Configurações Ativas</h3>
              <div className="flex gap-4 mb-4">
                <select
                  value={configFilters.category}
                  onChange={(e) => setConfigFilters({ ...configFilters, category: e.target.value })}
                  className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Todas Categorias</option>
                  {[...new Set(searchConfigs.map(c => c.category))].map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <select
                  value={configFilters.website}
                  onChange={(e) => setConfigFilters({ ...configFilters, website: e.target.value })}
                  className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Todos Sites</option>
                  <option value="kabum">Kabum</option>
                  <option value="pichau">Pichau</option>
                  <option value="terabyte">Terabyte</option>
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {getFilteredConfigs.map(config => (
                  <div key={config.id} className="bg-gray-700 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium">{config.search_text}</span>
                      <button
                        onClick={() => deleteSearchConfig(config.id)}
                        className="text-red-400 hover:text-red-300"
                      >
                        🗑️
                      </button>
                    </div>
                    <div className="flex gap-2 mb-2">
                      <span className="text-xs bg-gray-600 px-2 py-1 rounded">{config.category}</span>
                      <span className="text-xs bg-gray-600 px-2 py-1 rounded">{config.website}</span>
                      <button
                        onClick={() => toggleSearchActive(config.id, config.is_active)}
                        className={`text-xs px-2 py-1 rounded ${config.is_active ? 'bg-green-600' : 'bg-red-600'
                          }`}
                      >
                        {config.is_active ? 'Ativo' : 'Inativo'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {config.keywordGroups.map((group, idx) => (
                        <span key={idx} className="text-xs bg-purple-600 px-2 py-1 rounded">
                          {group}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Login Modal */}
      {showLogin && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md animate-slide-up">
            <h2 className="text-xl font-bold mb-4">Login Admin</h2>
            <form onSubmit={handleLogin} className="space-y-4">
              <input
                type="email"
                placeholder="Email"
                value={loginCreds.email}
                onChange={(e) => setLoginCreds({ ...loginCreds, email: e.target.value })}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
              <input
                type="password"
                placeholder="Senha"
                value={loginCreds.password}
                onChange={(e) => setLoginCreds({ ...loginCreds, password: e.target.value })}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors"
                >
                  Entrar
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogin(false)}
                  className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-md font-medium transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Price History Modal - Melhorado com Intervalos */}
      {selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-5xl max-h-[95vh] overflow-auto animate-slide-up">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="text-xl font-bold">Histórico de Preços</h3>
                <h4 className="text-lg text-gray-300 mt-1">{selectedProduct.name}</h4>
                <p className="text-sm text-gray-400">{selectedProduct.category} • {selectedProduct.website}</p>
              </div>
              <button
                onClick={() => setSelectedProduct(null)}
                className="text-gray-400 hover:text-white text-2xl p-2 hover:bg-gray-700 rounded-lg transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Seletor de Intervalo */}
            <div className="mb-4 p-3 bg-gray-700 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">Intervalo de tempo:</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: '1h', label: '1 hora (24h)', desc: 'Últimas 24 horas' },
                  { value: '6h', label: '6 horas (6 dias)', desc: 'Últimos 6 dias' },
                  { value: '1d', label: '1 dia (30 dias)', desc: 'Últimos 30 dias' },
                  { value: '1w', label: '1 semana (3 meses)', desc: 'Últimos 3 meses' }
                ].map(interval => (
                  <button
                    key={interval.value}
                    onClick={() => handleIntervalChange(interval.value)}
                    className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${chartInterval === interval.value
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                      }`}
                    title={interval.desc}
                  >
                    {interval.label}
                  </button>
                ))}
              </div>
            </div>

            <PriceChart data={priceHistory} />

            <div className="mt-6 flex gap-4">
              <a
                href={selectedProduct.product_link}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors text-center"
              >
                Ver no Site 🔗
              </a>
              <div className="flex-1 text-right text-sm text-gray-400">
                <div>
                  Última atualização: {selectedProduct.lastUpdated ?
                    new Date(selectedProduct.lastUpdated).toLocaleString('pt-BR') :
                    'Não disponível'
                  }
                </div>
                <div className="mt-1">
                  Mostrando: {priceHistory.length} ponto(s) de dados
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Build Product Selection Modal */}
      {buildProductModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[80vh] overflow-auto animate-slide-up">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold">
                Selecionar Produto - {buildProductModal.category.replace('_', ' ').toUpperCase()}
              </h3>
              <button
                onClick={() => setBuildProductModal(null)}
                className="text-gray-400 hover:text-white text-2xl"
              >
                ✕
              </button>
            </div>
            <div className="mb-4">
              <p className="text-sm text-gray-400">Produto atual:</p>
              <p className="font-medium truncate max-w-[250px]">{buildProductModal.currentProduct.name}</p>
              <p className="text-purple-400">R$ {buildProductModal.currentProduct.currentPrice.toFixed(2)}</p>
            </div>
            <div className="border-t border-gray-700 pt-4">
              <h4 className="font-medium mb-4">Produtos disponíveis:</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {products
                  .filter(p => p.category === buildProductModal.category)
                  .sort((a, b) => a.currentPrice - b.currentPrice)
                  .map(product => (
                    <div
                      key={product.id}
                      className={`bg-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-600 transition-colors ${product.id === buildProductModal.currentProduct.id ? 'ring-2 ring-purple-500' : ''
                        }`}
                      onClick={() => updateBuildProduct(buildProductModal.buildId, buildProductModal.category, product.id)}
                    >
                      <p className="font-medium text-sm mb-1 truncate max-w-[250px]">{product.name}</p>
                      <div className="flex justify-between items-center">
                        <span className="text-purple-400 font-bold">R$ {product.currentPrice.toFixed(2)}</span>
                        <span className="text-xs text-gray-400">{product.website}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}