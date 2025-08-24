import { useState } from "react";
import { Layout } from "@/components/Layout";
import { PriceChart } from "@/components/PriceChart";
import { useAuth } from "@/hooks/useAuth";
import { useProducts } from "@/hooks/useProducts";
import { supabaseClient } from "@/utils/supabase";

export default function Home() {
  const [activeTab, setActiveTab] = useState('home');
  const [expandedBuildProduct, setExpandedBuildProduct] = useState(null);

  const {
    userRole,
    showLogin,
    setShowLogin,
    loginCreds,
    setLoginCreds,
    handleLogin,
    handleLogout
  } = useAuth();

  const {
    builds,
    setBuilds,
    products,
    loading,
    searchConfigs,
    setSearchConfigs,
    topDrops,
    setTopDrops,
    selectedProduct,
    setSelectedProduct,
    priceHistory,
    chartInterval,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    searchTerm,
    setSearchTerm,
    selectedCategories,
    setSelectedCategories,
    selectedWebsites,
    setSelectedWebsites,
    buildProductModal,
    setBuildProductModal,
    newBuild,
    setNewBuild,
    configFilters,
    setConfigFilters,
    globalSearchToggle,
    setGlobalSearchToggle,
    newSearch,
    setNewSearch,
    getSortedProducts,
    allCategories,
    allWebsites,
    showPriceModal,
    handleIntervalChange,
    deleteProduct,
    promotionPeriod,
    setPromotionPeriod,
    calculatePromotions
  } = useProducts();

  // Função para recalcular promoções quando o período muda
  const handlePeriodChange = async (newPeriod) => {
    setPromotionPeriod(newPeriod);
    const filteredProducts = products.filter(p => p.currentPrice > 0);
    const newPromotions = await calculatePromotions(filteredProducts, newPeriod);
    setTopDrops(newPromotions);
  };

  const calculateBuildTotal = (build) => {
    if (!build.categories || !products.length) return 0;

    return build.categories.reduce((total, category) => {
      const quantity = build.product_quantities?.[category] || 1;

      if (build.product_overrides?.[category]) {
        const overrideProduct = products.find(p => p.id === build.product_overrides[category]);
        return total + (overrideProduct?.currentPrice || 0) * quantity;
      }
      const lowestInCategory = products
        .filter(p => p.category === category)
        .sort((a, b) => a.currentPrice - b.currentPrice)[0];
      return total + (lowestInCategory?.currentPrice || 0) * quantity;
    }, 0);
  };

  const updateProductQuantity = async (buildId, category, newQuantity) => {
    const build = builds.find(b => b.id === buildId);
    const newQuantities = {
      ...build.product_quantities,
      [category]: Math.max(1, newQuantity)
    };

    await supabaseClient
      .from('builds')
      .update({
        product_quantities: newQuantities,
        auto_refresh: false
      })
      .eq('id', buildId);

    setBuilds(prev => prev.map(b =>
      b.id === buildId
        ? { ...b, product_quantities: newQuantities, auto_refresh: false }
        : b
    ));
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

    const initialQuantities = {};
    newBuild.categories.forEach(category => {
      initialQuantities[category] = 1;
    });

    const buildToInsert = {
      ...newBuild,
      product_quantities: initialQuantities
    };

    const { error } = await supabaseClient
      .from('builds')
      .insert([buildToInsert]);

    if (!error) {
      setNewBuild({
        name: '',
        categories: [],
        auto_refresh: true,
        product_overrides: {},
        product_quantities: {}
      });
      window.location.reload();
    }
  };

  const deleteBuild = async (id) => {
    if (confirm('Remover esta build?')) {
      await supabaseClient.from('builds').delete().eq('id', id);
      setBuilds(prev => prev.filter(b => b.id !== id));
    }
  };

  // Funções de configurações de busca
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

  const toggleAllSearches = async (newStatus) => {
    try {
      await Promise.all(
        searchConfigs.map(config =>
          supabaseClient
            .from('search_configs')
            .update({ is_active: newStatus })
            .eq('id', config.id)
        )
      );

      setSearchConfigs(prev => prev.map(config => ({
        ...config,
        is_active: newStatus
      })));

      setGlobalSearchToggle(newStatus);
    } catch (error) {
      console.error('Error toggling all searches:', error);
    }
  };

  const deleteSearchConfig = async (id) => {
    if (confirm('Remover esta configuração?')) {
      await supabaseClient.from('search_configs').delete().eq('id', id);
      setSearchConfigs(prev => prev.filter(c => c.id !== id));
    }
  };

  const getFilteredConfigs = () => {
    let filtered = [...searchConfigs];
    if (configFilters.category) {
      filtered = filtered.filter(c => c.category === configFilters.category);
    }
    if (configFilters.website) {
      filtered = filtered.filter(c => c.website === configFilters.website);
    }
    return filtered;
  };

  // Componente de controle de quantidade - RESPONSIVO
  const QuantityControl = ({ quantity, onIncrease, onDecrease }) => (
    <div className="flex items-center space-x-1 sm:space-x-2 bg-gray-600 rounded-md">
      <button
        onClick={onDecrease}
        className="w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center text-gray-300 hover:text-white hover:bg-gray-500 rounded-l-md transition-colors text-xs"
        disabled={quantity <= 1}
      >
        −
      </button>
      <span className="w-6 sm:w-8 text-center text-xs sm:text-sm font-medium">{quantity}</span>
      <button
        onClick={onIncrease}
        className="w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center text-gray-300 hover:text-white hover:bg-gray-500 rounded-r-md transition-colors text-xs"
      >
        +
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-500"></div>
      </div>
    );
  }

  return (
    <Layout
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      userRole={userRole}
      handleLogin={handleLogin}
      handleLogout={handleLogout}
      showLogin={showLogin}
      setShowLogin={setShowLogin}
      loginCreds={loginCreds}
      setLoginCreds={setLoginCreds}
    >
      {activeTab === 'home' && (
        <div className="space-y-6 sm:space-y-8 animate-fade-in">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700">
            {/* Cabeçalho com seletor de período - RESPONSIVO */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-6">
              <h2 className="text-xl sm:text-2xl font-bold flex items-center">
                <span className="mr-2">🔥</span> Melhores Promoções
              </h2>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                <span className="text-sm text-gray-400">Período de análise:</span>
                <select
                  value={promotionPeriod}
                  onChange={(e) => handlePeriodChange(e.target.value)}
                  className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 min-w-0"
                >
                  <option value="24h">Últimas 24h</option>
                  <option value="1w">Última semana</option>
                  <option value="1m">Último mês</option>
                  <option value="all">Desde sempre</option>
                </select>
              </div>
            </div>

            {/* Informações do período atual - RESPONSIVO */}
            <div className="mb-4 p-3 bg-gray-700 rounded-lg">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm">
                <div className="text-gray-300 break-words">
                  {promotionPeriod === '24h' && '📊 Analisando preços das últimas 24 horas (mín. 2 registros, desconto mín. 5%)'}
                  {promotionPeriod === '1w' && '📊 Analisando preços da última semana (mín. 3 registros, desconto mín. 8%)'}
                  {promotionPeriod === '1m' && '📊 Analisando preços do último mês (mín. 5 registros, desconto mín. 10%)'}
                  {promotionPeriod === 'all' && '📊 Analisando todo o histórico disponível (mín. 3 registros, desconto mín. 10%)'}
                </div>
                <div className="text-gray-400 text-right flex-shrink-0">
                  {topDrops.length} promoção(ões) encontrada(s)
                </div>
              </div>
            </div>

            {/* Lista de promoções - RESPONSIVO */}
            <div className="space-y-3">
              {topDrops.length > 0 ? (
                topDrops.map((product, idx) => (
                  <div key={product.id} className="bg-gray-700 rounded-lg p-3 sm:p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
                      {/* Ranking */}
                      <span className="text-xl sm:text-2xl font-bold text-gray-400 flex-shrink-0 self-start sm:self-center">
                        #{idx + 1}
                      </span>
                      
                      <div className="min-w-0 flex-1">
                        {/* Product Info */}
                        <div className="mb-2">
                          <p className="font-medium text-sm sm:text-base break-words line-clamp-2">
                            {product.name}
                          </p>
                          <p className="text-xs sm:text-sm text-gray-400">
                            {product.category} • {product.website}
                          </p>
                        </div>
                        
                        {/* Tags e informações */}
                        <div className="flex flex-wrap gap-1 sm:gap-2 mb-2 sm:mb-0">
                          <span className="text-xs bg-purple-600 px-2 py-1 rounded">
                            {product.priceHistory} preços analisados
                          </span>
                          {product.baseline && (
                            <span className="text-xs text-gray-400 bg-gray-600 px-2 py-1 rounded">
                              {promotionPeriod === '24h' ? 'Máximo' : 'Base'}: R$ {product.baseline.toFixed(2)}
                            </span>
                          )}
                          {product.discountAmount && (
                            <span className="text-xs text-green-400 bg-gray-600 px-2 py-1 rounded">
                              Economia: R$ {product.discountAmount.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {/* Preço e ações */}
                      <div className="flex flex-row sm:flex-col items-end sm:items-end justify-between sm:justify-start gap-3 sm:gap-2 flex-shrink-0">
                        <div className="text-left sm:text-right">
                          <p className="text-base sm:text-lg font-bold text-green-400">
                            R$ {product.currentPrice.toFixed(2)}
                          </p>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-1">
                            {product.historicalLow && (
                              <p className="text-xs text-gray-400">
                                Menor: R$ {product.historicalLow.toFixed(2)}
                              </p>
                            )}
                            {product.historicalHigh && product.historicalLow && (
                              <p className="text-xs text-gray-500">
                                ↔ R$ {product.priceRange.toFixed(2)}
                              </p>
                            )}
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <div className="bg-red-600 px-2 sm:px-3 py-1 rounded-full">
                            <span className="font-bold text-white text-xs sm:text-sm">
                              -{product.promotionScore}%
                            </span>
                          </div>
                          <button
                            onClick={() => showPriceModal(product)}
                            className="text-gray-400 hover:text-white transition-colors p-1"
                            title="Ver gráfico de preços"
                          >
                            📊
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-gray-400">
                  <p className="text-lg sm:text-xl">🔍 Nenhuma promoção encontrada neste período</p>
                  <p className="text-sm mt-2 px-4 break-words">
                    {promotionPeriod === '24h' && 'Tente aumentar o período para "Última semana" ou verifique se há dados suficientes.'}
                    {promotionPeriod === '1w' && 'Tente "Último mês" ou "Desde sempre" para encontrar mais promoções.'}
                    {promotionPeriod === '1m' && 'Tente "Desde sempre" ou aguarde mais dados serem coletados.'}
                    {promotionPeriod === 'all' && 'Aguarde mais dados serem coletados pelo scraper ou ajuste os critérios.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'builds' && (
        <div className="space-y-4 sm:space-y-6 animate-fade-in">
          {/* Formulário de nova build - RESPONSIVO */}
          {userRole === 'admin' && (
            <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700">
              <h3 className="text-lg font-bold mb-4">Nova Build</h3>
              <div className="space-y-4">
                <input
                  type="text"
                  placeholder="Nome da Build"
                  value={newBuild.name}
                  onChange={(e) => setNewBuild({ ...newBuild, name: e.target.value })}
                  className="w-full px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                />
                <div className="max-h-32 sm:max-h-40 overflow-y-auto">
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
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
                          className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 rounded focus:ring-purple-500 flex-shrink-0"
                        />
                        <span className="text-xs sm:text-sm break-words">
                          {category.replace('_', ' ').toUpperCase()}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <button
                  onClick={createBuild}
                  className="w-full sm:w-auto px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors text-sm sm:text-base"
                >
                  Criar Build
                </button>
              </div>
            </div>
          )}

          {/* Lista de builds - RESPONSIVO */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
            {builds.map(build => (
              <div key={build.id} className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
                  <h3 className="text-lg sm:text-xl font-bold break-words">{build.name}</h3>
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
                        className="text-red-400 hover:text-red-300 p-1"
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
                    const quantity = build.product_quantities?.[category] || 1;

                    return product ? (
                      <div key={category} className="bg-gray-700 rounded p-3">
                        <div className="flex flex-col gap-2">
                          {/* Cabeçalho do produto */}
                          <div className="flex justify-between items-start">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-gray-400 uppercase">
                                {category.replace('_', ' ')}
                              </p>
                              <p className="text-sm font-medium break-words line-clamp-2">
                                {product.name}
                              </p>
                              <p className="text-xs text-gray-500 capitalize">{product.website}</p>
                            </div>
                            
                            {/* Preço e indicador de override */}
                            <div className="text-right flex-shrink-0 ml-2">
                              <div className="flex items-center gap-1">
                                <span className="font-bold text-purple-400 text-sm sm:text-base">
                                  R$ {(product.currentPrice * quantity).toFixed(2)}
                                </span>
                                {isOverride && <span className="text-xs text-yellow-400">✏️</span>}
                              </div>
                              {quantity > 1 && (
                                <p className="text-xs text-gray-400">
                                  {quantity}x R$ {product.currentPrice.toFixed(2)}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Ações e controles */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            {/* Info de mudança de preço */}
                            <div className="flex-1">
                              {product.priceChange !== 0 && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs text-gray-400">Variação 24h:</span>
                                  <span className={`text-xs font-medium ${
                                    product.priceChange < 0 ? 'text-green-400' : 'text-red-400'
                                  }`}>
                                    {product.priceChange > 0 ? '+' : ''}{product.priceChange.toFixed(1)}%
                                  </span>
                                  {product.previousPrice && product.previousPrice !== product.currentPrice && (
                                    <span className="text-xs text-gray-500 line-through">
                                      R$ {(product.previousPrice * quantity).toFixed(2)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Controles */}
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {/* Controle de quantidade */}
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-gray-400">Qtd:</span>
                                <QuantityControl
                                  quantity={quantity}
                                  onIncrease={() => updateProductQuantity(build.id, category, quantity + 1)}
                                  onDecrease={() => updateProductQuantity(build.id, category, quantity - 1)}
                                />
                              </div>

                              {/* Botões de ação */}
                              <div className="flex gap-1">
                                <button
                                  onClick={() => showPriceModal(product)}
                                  className="text-gray-400 hover:text-white transition-colors p-1"
                                  title="Ver gráfico de preços"
                                >
                                  📊
                                </button>
                                <a
                                  href={product.product_link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-gray-400 hover:text-white transition-colors p-1"
                                  title="Ver no site"
                                >
                                  🔗
                                </a>
                                <button
                                  onClick={() => setBuildProductModal({ 
                                    buildId: build.id, 
                                    category, 
                                    currentProduct: product 
                                  })}
                                  className="text-gray-400 hover:text-white transition-colors p-1"
                                  title="Trocar produto"
                                >
                                  ⚙️
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
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
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p className="text-lg sm:text-xl font-bold text-purple-400">
                      Total: R$ {calculateBuildTotal(build).toFixed(2)}
                    </p>
                    <div className="text-left sm:text-right text-xs text-gray-400">
                      {build.categories.reduce((total, category) => {
                        const quantity = build.product_quantities?.[category] || 1;
                        return total + quantity;
                      }, 0)} item(s) • {build.categories.length} categoria(s)
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'products' && (
        <div className="space-y-4 sm:space-y-6 animate-fade-in">
          {/* Filtros - RESPONSIVO */}
          <div className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700">
            {/* Linha de busca e ordenação */}
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-4">
              <input
                type="text"
                placeholder="Buscar produtos..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 min-w-0 px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
              />
              <div className="flex gap-2 sm:gap-3">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm flex-1 sm:flex-none min-w-0"
                >
                  <option value="price">Preço</option>
                  <option value="category">Categoria</option>
                  <option value="drop">Maior Queda %</option>
                </select>
                <button
                  onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                  className="px-3 sm:px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-md transition-colors text-sm flex-shrink-0"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>

            {/* Filtros */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              {/* Filtro de categorias */}
              <div>
                <p className="text-sm text-gray-400 mb-2">Filtrar por categoria:</p>
                <div className="max-h-24 sm:max-h-32 overflow-y-auto">
                  <div className="flex flex-wrap gap-2">
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
                        <span className="text-xs break-words">
                          {category.replace('_', ' ').toUpperCase()}
                        </span>
                      </label>
                    ))}
                  </div>
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

              {/* Filtro de websites */}
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
                      <span className="text-xs capitalize break-words">{website}</span>
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

            {/* Resumo dos filtros ativos */}
            {(selectedCategories.length > 0 || selectedWebsites.length > 0 || searchTerm) && (
              <div className="mt-4 p-3 bg-gray-700 rounded-md">
                <p className="text-sm text-gray-300 break-words">
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

          {/* Grid de produtos - RESPONSIVO */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
            {getSortedProducts.map(product => (
              <div key={product.id} className="bg-gray-800 rounded-lg p-3 sm:p-4 border border-gray-700 hover:border-purple-500 transition-colors">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-2 gap-2">
                  <span className="text-xs bg-purple-600 px-2 py-1 rounded w-fit">
                    {product.category.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="text-xs text-gray-400 capitalize">{product.website}</span>
                </div>
                
                <h4 className="text-sm font-medium mb-3 line-clamp-3 break-words overflow-hidden">
                  {product.name}
                </h4>
                
                <div className="flex justify-between items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-lg sm:text-xl font-bold text-purple-400 break-words">
                      R$ {product.currentPrice.toFixed(2)}
                    </p>
                    {product.priceChange !== 0 && (
                      <p className={`text-xs ${product.priceChange < 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {product.priceChange.toFixed(1)}%
                      </p>
                    )}
                  </div>
                  
                  <div className="flex space-x-1 sm:space-x-2 flex-shrink-0">
                    <button
                      onClick={() => showPriceModal(product)}
                      className="text-gray-400 hover:text-white p-1"
                      title="Ver gráfico de preços"
                    >
                      📊
                    </button>
                    <a
                      href={product.product_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-400 hover:text-white p-1"
                      title="Ver no site"
                    >
                      🔗
                    </a>
                    {userRole === 'admin' && (
                      <button
                        onClick={() => deleteProduct(product.id, product.name)}
                        className="text-red-400 hover:text-red-300 p-1"
                        title="Deletar produto"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'admin' && userRole === 'admin' && (
        <div className="space-y-4 sm:space-y-6 animate-fade-in">
          {/* Nova configuração de busca - RESPONSIVO */}
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700">
            <h3 className="text-lg font-bold mb-4">Nova Configuração de Busca</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <input
                type="text"
                placeholder="Termo de busca"
                value={newSearch.search_text}
                onChange={(e) => setNewSearch({ ...newSearch, search_text: e.target.value })}
                className="px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
              />
              <input
                type="text"
                placeholder="Categoria"
                value={newSearch.category}
                onChange={(e) => setNewSearch({ ...newSearch, category: e.target.value })}
                className="px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
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
                    className="flex-1 px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                  {newSearch.keywordGroups.length > 1 && (
                    <button
                      onClick={() => {
                        setNewSearch({
                          ...newSearch,
                          keywordGroups: newSearch.keywordGroups.filter((_, i) => i !== idx)
                        });
                      }}
                      className="px-3 py-2 bg-red-600 hover:bg-red-700 rounded-md transition-colors text-sm flex-shrink-0"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setNewSearch({ ...newSearch, keywordGroups: [...newSearch.keywordGroups, ''] })}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-md transition-colors text-sm"
              >
                + Adicionar Grupo
              </button>
            </div>
            <div className="flex flex-wrap gap-4 mb-4">
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
              className="w-full sm:w-auto px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors text-sm sm:text-base"
            >
              Adicionar Configuração
            </button>
          </div>

          {/* Configurações ativas - RESPONSIVO */}
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-4 gap-3">
              <h3 className="text-lg font-bold">Configurações Ativas</h3>
              <button
                onClick={() => toggleAllSearches(!globalSearchToggle)}
                className={`px-4 py-2 rounded-md font-medium transition-colors text-sm sm:text-base ${globalSearchToggle
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}
              >
                {globalSearchToggle ? '🛑 Desativar Todas' : '✅ Ativar Todas'}
              </button>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-4 mb-4">
              <select
                value={configFilters.category}
                onChange={(e) => setConfigFilters({ ...configFilters, category: e.target.value })}
                className="px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              >
                <option value="">Todas Categorias</option>
                {[...new Set(searchConfigs.map(c => c.category))].map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <select
                value={configFilters.website}
                onChange={(e) => setConfigFilters({ ...configFilters, website: e.target.value })}
                className="px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              >
                <option value="">Todos Sites</option>
                <option value="kabum">Kabum</option>
                <option value="pichau">Pichau</option>
                <option value="terabyte">Terabyte</option>
              </select>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {getFilteredConfigs().map(config => (
                <div key={config.id} className="bg-gray-700 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-medium break-words pr-2">{config.search_text}</span>
                    <button
                      onClick={() => deleteSearchConfig(config.id)}
                      className="text-red-400 hover:text-red-300 flex-shrink-0"
                    >
                      🗑️
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 mb-2">
                    <span className="text-xs bg-gray-600 px-2 py-1 rounded">{config.category}</span>
                    <span className="text-xs bg-gray-600 px-2 py-1 rounded">{config.website}</span>
                    <button
                      onClick={() => toggleSearchActive(config.id, config.is_active)}
                      className={`text-xs px-2 py-1 rounded ${config.is_active ? 'bg-green-600' : 'bg-red-600'}`}
                    >
                      {config.is_active ? 'Ativo' : 'Inativo'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {config.keywordGroups.map((group, idx) => (
                      <span key={idx} className="text-xs bg-purple-600 px-2 py-1 rounded break-words">
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

      {/* Price History Modal - RESPONSIVO */}
      {selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 w-full max-w-5xl max-h-[95vh] overflow-auto animate-slide-up">
            <div className="flex justify-between items-center mb-4">
              <div className="min-w-0 flex-1 pr-4">
                <h3 className="text-lg sm:text-xl font-bold">Histórico de Preços</h3>
                <h4 className="text-base sm:text-lg text-gray-300 mt-1 break-words">
                  {selectedProduct.name}
                </h4>
                <p className="text-sm text-gray-400">
                  {selectedProduct.category} • {selectedProduct.website}
                </p>
              </div>
              <button
                onClick={() => setSelectedProduct(null)}
                className="text-gray-400 hover:text-white text-xl sm:text-2xl p-1 sm:p-2 hover:bg-gray-700 rounded-lg transition-colors flex-shrink-0"
              >
                ✕
              </button>
            </div>

            <div className="mb-4 p-3 bg-gray-700 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">
                Intervalo de tempo: <span className="text-gray-300">intervalo(período total)</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {[
                  { value: '1h', label: '1 hora (24h)', desc: 'Pontos a cada 1 hora, últimas 24 horas' },
                  { value: '6h', label: '6 horas (6 dias)', desc: 'Pontos a cada 6 horas, últimos 6 dias' },
                  { value: '1d', label: '1 dia (30 dias)', desc: 'Pontos a cada 1 dia, últimos 30 dias' },
                  { value: '1w', label: '1 semana (3 meses)', desc: 'Pontos a cada 1 semana, últimos 3 meses' }
                ].map(interval => (
                  <button
                    key={interval.value}
                    onClick={() => handleIntervalChange(interval.value)}
                    className={`px-3 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors break-words ${
                      chartInterval === interval.value
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

            <div className="mt-6 flex flex-col sm:flex-row gap-4">
              <a
                href={selectedProduct.product_link}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors text-center text-sm sm:text-base"
              >
                Ver no Site 🔗
              </a>
              <div className="flex-1 text-center sm:text-right text-sm text-gray-400">
                <div className="break-words">
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

      {/* Build Product Selection Modal - RESPONSIVO */}
      {buildProductModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 w-full max-w-4xl max-h-[80vh] overflow-auto animate-slide-up">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg sm:text-xl font-bold break-words pr-4">
                Selecionar Produto - {buildProductModal.category.replace('_', ' ').toUpperCase()}
              </h3>
              <button
                onClick={() => setBuildProductModal(null)}
                className="text-gray-400 hover:text-white text-xl sm:text-2xl flex-shrink-0"
              >
                ✕
              </button>
            </div>
            
            <div className="mb-4 p-3 bg-gray-700 rounded-lg">
              <p className="text-sm text-gray-400">Produto atual:</p>
              <p className="font-medium break-words">{buildProductModal.currentProduct.name}</p>
              <p className="text-purple-400">R$ {buildProductModal.currentProduct.currentPrice.toFixed(2)}</p>
            </div>
            
            <div className="border-t border-gray-700 pt-4">
              <h4 className="font-medium mb-4">Produtos disponíveis:</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 max-h-96 overflow-y-auto">
                {products
                  .filter(p => p.category === buildProductModal.category)
                  .sort((a, b) => a.currentPrice - b.currentPrice)
                  .map(product => (
                    <div
                      key={product.id}
                      className={`bg-gray-700 rounded-lg p-3 sm:p-4 cursor-pointer hover:bg-gray-600 transition-colors ${
                        product.id === buildProductModal.currentProduct.id ? 'ring-2 ring-purple-500' : ''
                      }`}
                      onClick={() => updateBuildProduct(buildProductModal.buildId, buildProductModal.category, product.id)}
                    >
                      <p className="font-medium text-sm mb-1 break-words line-clamp-2">
                        {product.name}
                      </p>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-purple-400 font-bold text-sm sm:text-base">
                          R$ {product.currentPrice.toFixed(2)}
                        </span>
                        <span className="text-xs text-gray-400 flex-shrink-0">{product.website}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}