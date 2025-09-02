import { useState, useEffect, useMemo } from 'react';
import { supabaseClient } from '@/utils/supabase';

export const useProducts = () => {
    const [builds, setBuilds] = useState([]);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchConfigs, setSearchConfigs] = useState([]);
    const [topDrops, setTopDrops] = useState([]);
    const [selectedProduct, setSelectedProduct] = useState(null);
    const [priceHistory, setPriceHistory] = useState([]);
    const [chartInterval, setChartInterval] = useState('6h');

    // Estados para filtros e ordenação
    const [sortBy, setSortBy] = useState('price');
    const [sortOrder, setSortOrder] = useState('asc');
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [selectedWebsites, setSelectedWebsites] = useState([]);

    // Estados para builds
    const [expandedBuildProduct, setExpandedBuildProduct] = useState(null);
    const [buildProductModal, setBuildProductModal] = useState(null);
    const [newBuild, setNewBuild] = useState({
        name: '',
        categories: [],
        auto_refresh: true,
        product_overrides: {},
        product_quantities: {}
    });

    // Estados para configurações de busca
    const [configFilters, setConfigFilters] = useState({ category: '', website: '' });
    const [globalSearchToggle, setGlobalSearchToggle] = useState(true);
    const [newSearch, setNewSearch] = useState({
        search_text: '',
        keywordGroups: [''],
        category: '',
        websites: { kabum: false, pichau: false, terabyte: false },
        is_active: true
    });

    // Estados para sistema de ocultação
    const [showHiddenProducts, setShowHiddenProducts] = useState(false);
    const [hiddenProducts, setHiddenProducts] = useState([]);
    const [priceLimits, setPriceLimits] = useState([]);
    const [loadingHidden, setLoadingHidden] = useState(false);

    // Estados para sistema de toast notifications
    const [toasts, setToasts] = useState([]);

    // Helper para obter token de autenticação
    const getAuthHeaders = async () => {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            
            if (session?.access_token) {
                return {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                };
            }
            
            return { 'Content-Type': 'application/json' };
        } catch (error) {
            console.error('Error getting auth token:', error);
            return { 'Content-Type': 'application/json' };
        }
    };

    useEffect(() => {
        if (typeof window === 'undefined') return;

        fetchInitialData();

        const pricesSubscription = supabaseClient
            .channel('price-changes')
            .on('postgres_changes', {
                event: '*', // Escutar INSERT, UPDATE e DELETE
                schema: 'public',
                table: 'prices'
            }, payload => {
                console.log(`🔄 Realtime: ${payload.eventType} em prices para produto ${payload.new?.product_id}`);
                
                if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                    const updatedPrice = parseFloat(payload.new.price);
                    const updatedAt = payload.new.last_checked_at || payload.new.collected_at || payload.new.price_changed_at;
                    
                    setProducts(prev => prev.map(product =>
                        product.id === payload.new.product_id
                            ? { 
                                ...product, 
                                currentPrice: updatedPrice,
                                lastUpdated: updatedAt,
                                // Recalcular change% com o preço anterior armazenado
                                priceChange: product.previousPrice > 0 
                                    ? ((updatedPrice - product.previousPrice) / product.previousPrice * 100)
                                    : 0
                            }
                            : product
                    ));
                    
                    // Também atualizar nas ofertas se necessário
                    setTopDrops(prev => prev.map(product =>
                        product.id === payload.new.product_id
                            ? { 
                                ...product, 
                                currentPrice: updatedPrice,
                                lastUpdated: updatedAt
                            }
                            : product
                    ));
                }
            })
            .subscribe();

        // Cleanup subscription
        return () => {
            if (pricesSubscription) {
                supabaseClient.removeChannel(pricesSubscription);
            }
        };
    }, []);

    const fetchInitialData = async () => {
        if (typeof window === 'undefined') return;

        try {
            console.log('🚀 Iniciando carregamento otimizado de dados...');
            
            // Buscar builds em paralelo
            const buildsPromise = supabaseClient
                .from('builds')
                .select('*')
                .order('created_at', { ascending: false });

            // Buscar produtos (filtrar ocultos por padrão)
            const productsPromise = supabaseClient
                .from('products')
                .select('*')
                .eq('is_hidden', false);

            const [{ data: buildsData }, { data: productsData }] = await Promise.all([
                buildsPromise,
                productsPromise
            ]);

            setBuilds(buildsData || []);
            console.log(`📁 ${productsData?.length || 0} produtos encontrados`);

            if (!productsData || productsData.length === 0) {
                setProducts([]);
                setTopDrops([]);
                setLoading(false);
                return;
            }

            // OTIMIZAÇÃO: Tentar usar a função RPC super otimizada primeiro
            console.log(`📊 Tentando busca ultra-otimizada de produtos com preços...`);
            
            // Tentar usar a função RPC completa (inclui produtos + preços em uma query)
            const { data: completeData, error: completeError } = await supabaseClient
                .rpc('get_products_with_latest_prices', { include_hidden: false });

            if (!completeError && completeData && completeData.length > 0) {
                console.log(`⭐ ULTRA-OTIMIZADO: ${completeData.length} produtos com preços obtidos em uma única query!`);
                
                // Converter para formato esperado
                const optimizedProducts = completeData.map(item => {
                    const product = {
                        id: item.product_id,
                        name: item.product_name,
                        category: item.product_category,
                        website: item.product_website,
                        product_link: item.product_link,
                        is_hidden: item.is_hidden,
                        hidden_reason: item.hidden_reason,
                        hidden_at: item.hidden_at,
                        currentPrice: parseFloat(item.current_price),
                        lastUpdated: item.last_checked_at || item.price_changed_at,
                        price_changed_at: item.price_changed_at
                    };
                    return product;
                }).filter(p => p.currentPrice > 0);

                // Para produtos otimizados, buscar histórico apenas para cálculo de média
                const productsWithHistory = await Promise.all(
                    optimizedProducts.map(async (product) => {
                        // Buscar apenas alguns registros históricos para média
                        const { data: historicalPrices } = await supabaseClient
                            .from('prices')
                            .select('price, check_count')
                            .eq('product_id', product.id)
                            .neq('price', product.currentPrice)
                            .order('price_changed_at', { ascending: false })
                            .limit(5); // Apenas 5 registros para performance

                        let weightedAverage = product.currentPrice;
                        let previousPrice = product.currentPrice;

                        if (historicalPrices && historicalPrices.length > 0) {
                            previousPrice = parseFloat(historicalPrices[0].price);
                            
                            const totalWeight = historicalPrices.reduce((sum, p) => sum + Math.max(1, p.check_count || 1), 0);
                            const weightedSum = historicalPrices.reduce((sum, p) => sum + (parseFloat(p.price) * Math.max(1, p.check_count || 1)), 0);

                            if (totalWeight > 0) {
                                weightedAverage = weightedSum / totalWeight;
                            }
                        }

                        const priceChange = previousPrice > 0 ? ((product.currentPrice - previousPrice) / previousPrice * 100) : 0;

                        return {
                            ...product,
                            previousPrice,
                            priceChange,
                            weightedAverage
                        };
                    })
                );

                console.log(`✅ OTIMIZADO: ${productsWithHistory.length} produtos processados com histórico`);
                
                setProducts(productsWithHistory);
                const promotionalProducts = await calculatePromotions(productsWithHistory);
                setTopDrops(promotionalProducts);
                console.log(`🎆 ${promotionalProducts.length} promoções encontradas`);
                
                await fetchSearchConfigs();
                console.log('✅ Carregamento ULTRA-OTIMIZADO completo!');
                setLoading(false);
                return; // Sair da função - já processamos tudo
            }

            console.log('⚠️ Função ultra-otimizada não disponível, usando método padrão otimizado...');

            // FALLBACK: OTIMIZAÇÃO com RPC de preços
            const productIds = productsData.map(p => p.id);
            console.log(`📊 Buscando preços para ${productIds.length} produtos...`);
            
            let latestPricesMap = {};
            const { data: rpcPrices, error: rpcError } = await supabaseClient
                .rpc('get_latest_prices_by_products', { product_ids: productIds });

            if (!rpcError && rpcPrices) {
                console.log(`✅ RPC: ${rpcPrices.length} preços obtidos via função otimizada`);
                rpcPrices.forEach(price => {
                    latestPricesMap[price.product_id] = {
                        price: parseFloat(price.price),
                        price_changed_at: price.price_changed_at,
                        last_checked_at: price.last_checked_at
                    };
                });
            } else {
                console.warn('⚠️ RPC de preços não disponível, usando consulta padrão...', rpcError?.message);
                
                // FALLBACK FINAL: buscar em lote usando IN
                const { data: batchPrices } = await supabaseClient
                    .from('prices')
                    .select('product_id, price, price_changed_at, last_checked_at')
                    .in('product_id', productIds)
                    .order('price_changed_at', { ascending: false });

                // Agrupar por product_id e pegar o mais recente
                if (batchPrices) {
                    const grouped = {};
                    batchPrices.forEach(price => {
                        if (!grouped[price.product_id]) {
                            grouped[price.product_id] = price;
                        }
                    });
                    
                    Object.entries(grouped).forEach(([productId, price]) => {
                        latestPricesMap[productId] = {
                            price: parseFloat(price.price),
                            price_changed_at: price.price_changed_at,
                            last_checked_at: price.last_checked_at
                        };
                    });
                    
                    console.log(`✅ Batch: ${Object.keys(latestPricesMap).length} preços obtidos em lote`);
                }
            }

            // Processar produtos com preços
            const productsWithPrices = await Promise.all(
                productsData.map(async (product) => {
                    const latestPrice = latestPricesMap[product.id];
                    
                    if (!latestPrice) {
                        return {
                            ...product,
                            currentPrice: 0,
                            previousPrice: 0,
                            priceChange: 0,
                            lastUpdated: null,
                            weightedAverage: 0
                        };
                    }

                    const currentPrice = latestPrice.price;
                    const lastUpdated = latestPrice.last_checked_at || latestPrice.price_changed_at;

                    // Para cálculo de média histórica, buscar apenas alguns registros históricos
                    const { data: historicalPrices } = await supabaseClient
                        .from('prices')
                        .select('price, check_count')
                        .eq('product_id', product.id)
                        .neq('price', currentPrice) // Excluir o preço atual
                        .order('price_changed_at', { ascending: false })
                        .limit(10); // Limitar a 10 registros históricos para performance

                    // Calcular média histórica ponderada
                    let weightedAverage = currentPrice;
                    let previousPrice = currentPrice;

                    if (historicalPrices && historicalPrices.length > 0) {
                        previousPrice = parseFloat(historicalPrices[0].price);
                        
                        const totalWeight = historicalPrices.reduce((sum, p) => sum + Math.max(1, p.check_count || 1), 0);
                        const weightedSum = historicalPrices.reduce((sum, p) => sum + (parseFloat(p.price) * Math.max(1, p.check_count || 1)), 0);

                        if (totalWeight > 0) {
                            weightedAverage = weightedSum / totalWeight;
                        }
                    }

                    const priceChange = previousPrice > 0 ? ((currentPrice - previousPrice) / previousPrice * 100) : 0;

                    return {
                        ...product,
                        currentPrice,
                        previousPrice,
                        priceChange,
                        lastUpdated,
                        weightedAverage,
                    };
                })
            );

            const validProducts = productsWithPrices.filter(p => p.currentPrice > 0);
            console.log(`✅ ${validProducts.length} produtos com preços válidos processados`);
            
            setProducts(validProducts);

            // Calcular promoções usando a nova lógica
            const promotionalProducts = await calculatePromotions(validProducts);
            setTopDrops(promotionalProducts);
            console.log(`🎆 ${promotionalProducts.length} promoções encontradas`);

            await fetchSearchConfigs();
            console.log('✅ Carregamento completo!');
            setLoading(false);
        } catch (error) {
            console.error('Error fetching data:', error);
            setLoading(false);
        }
    };

    // Funções para gerenciar configurações de busca
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
            const activeCount = configsWithKeywords.filter(c => c.is_active).length;
            const totalCount = configsWithKeywords.length;
            setGlobalSearchToggle(activeCount === totalCount && totalCount > 0);
        } catch (error) {
            console.error('Error fetching configs:', error);
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
            await fetchSearchConfigs();
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

    // Calcular promoções (mantém a função existente)
    const calculatePromotions = async (productsWithPrices) => {
        const promotionalProducts = productsWithPrices.map(product => {
            try {
                if (!product.weightedAverage || product.weightedAverage === product.currentPrice) {
                    return {
                        ...product,
                        isPromotion: false,
                        promotionScore: 0,
                        reason: 'Sem histórico ou preço igual à média'
                    };
                }

                const currentPrice = product.currentPrice;
                const weightedAverage = product.weightedAverage;

                const discountPercent = ((weightedAverage - currentPrice) / weightedAverage) * 100;

                const isSignificantDiscount = discountPercent >= 10;
                const hasMinimumPrice = currentPrice >= 20;
                const isReasonableDiscount = discountPercent <= 80;

                const discountAmount = weightedAverage - currentPrice;

                const isPromotion = isSignificantDiscount &&
                    hasMinimumPrice &&
                    isReasonableDiscount &&
                    discountAmount > 0;

                return {
                    ...product,
                    isPromotion,
                    promotionScore: Math.round(Math.max(0, discountPercent)),
                    discountAmount,
                    reason: isPromotion ? 'Desconto real detectado' :
                        !isSignificantDiscount ? `Desconto insuficiente (${discountPercent.toFixed(1)}%)` :
                            !hasMinimumPrice ? 'Preço muito baixo' :
                                !isReasonableDiscount ? 'Desconto suspeito' :
                                    discountAmount <= 0 ? 'Preço atual maior que média' : 'Outros critérios'
                };
            } catch (error) {
                console.error(`Error calculating promotion for product ${product.id}:`, error);
                return { ...product, isPromotion: false, promotionScore: 0, reason: 'Erro no cálculo' };
            }
        });

        return promotionalProducts
            .filter(p => p.isPromotion)
            .sort((a, b) => b.promotionScore - a.promotionScore)
            .slice(0, 15);
    };

    const fetchPriceHistory = async (productId, interval = '6h') => {
        try {
            let totalHours, intervalHours, expectedPoints;

            switch (interval) {
                case '1h':
                    totalHours = 24;
                    intervalHours = 1;
                    expectedPoints = 24;
                    break;
                case '6h':
                    totalHours = 144;
                    intervalHours = 6;
                    expectedPoints = 24;
                    break;
                case '1d':
                    totalHours = 720;
                    intervalHours = 24;
                    expectedPoints = 30;
                    break;
                case '1w':
                    totalHours = 2160;
                    intervalHours = 168;
                    expectedPoints = 12;
                    break;
                default:
                    totalHours = 144;
                    intervalHours = 6;
                    expectedPoints = 24;
            }

            const startDate = new Date();
            startDate.setHours(startDate.getHours() - totalHours);

            const { data } = await supabaseClient
                .from('prices')
                .select('price, collected_at, price_changed_at')
                .eq('product_id', productId)
                .gte('price_changed_at', startDate.toISOString())
                .order('price_changed_at', { ascending: true })
                .limit(expectedPoints * 2);

            if (!data || data.length === 0) {
                setPriceHistory([]);
                return;
            }

            if (data.length <= expectedPoints) {
                setPriceHistory(data);
                return;
            }

            const filteredData = [];
            const totalDataPoints = data.length;
            const step = Math.max(1, Math.floor(totalDataPoints / expectedPoints));

            for (let i = 0; i < totalDataPoints; i += step) {
                filteredData.push(data[i]);
            }

            const lastPoint = data[data.length - 1];
            const lastFilteredPoint = filteredData[filteredData.length - 1];
            if (lastPoint.price_changed_at !== lastFilteredPoint.price_changed_at) {
                filteredData.push(lastPoint);
            }

            setPriceHistory(filteredData);
        } catch (error) {
            console.error('Error fetching price history:', error);
            setPriceHistory([]);
        }
    };

    const showPriceModal = async (product) => {
        setSelectedProduct(product);
        setChartInterval('6h');
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
                const getDiscount = (product) => {
                    if (!product.weightedAverage || product.weightedAverage === product.currentPrice) {
                        return 0;
                    }
                    return ((product.weightedAverage - product.currentPrice) / product.weightedAverage) * 100;
                };

                const discountA = getDiscount(a);
                const discountB = getDiscount(b);

                comparison = discountB - discountA;
            }
            return sortOrder === 'asc' ? comparison : -comparison;
        });

        return sorted;
    }, [products, searchTerm, selectedCategories, selectedWebsites, sortBy, sortOrder]);

    const allCategories = useMemo(() =>
        [...new Set(products.map(p => p.category))].sort(),
        [products]
    );

    const allWebsites = useMemo(() =>
        [...new Set(products.map(p => p.website))].sort(),
        [products]
    );

    const deleteProduct = async (id, productName) => {
        if (confirm(`Remover o produto "${productName}"?\n\nISTO IRÁ APAGAR TAMBÉM TODO O HISTÓRICO DE PREÇOS!`)) {
            try {
                // Toast de feedback instantâneo
                showInfo(`Removendo produto "${productName}"...`, 2000);
                
                await supabaseClient.from('prices').delete().eq('product_id', id);
                await supabaseClient.from('products').delete().eq('id', id);
                setProducts(prev => prev.filter(p => p.id !== id));

                if (selectedProduct && selectedProduct.id === id) {
                    setSelectedProduct(null);
                }

                console.log(`✅ Produto "${productName}" e seu histórico de preços foram removidos`);
                showSuccess(`Produto "${productName}" foi removido com sucesso`);
            } catch (error) {
                console.error('Erro ao deletar produto:', error);
                showError('Erro ao deletar produto. Tente novamente.');
            }
        }
    };

    // ℹ️ FUNÇÕES PARA TOAST NOTIFICATIONS
    const addToast = (message, type = 'info', duration = 4000) => {
        const id = Date.now() + Math.random();
        const toast = { id, message, type, duration, timestamp: Date.now() };
        
        setToasts(prev => [...prev, toast]);
        
        if (duration > 0) {
            setTimeout(() => removeToast(id), duration);
        }
        
        return id;
    };
    
    const removeToast = (id) => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
    };
    
    const showSuccess = (message, duration = 3000) => addToast(message, 'success', duration);
    const showError = (message, duration = 6000) => addToast(message, 'error', duration);
    const showWarning = (message, duration = 4000) => addToast(message, 'warning', duration);
    const showInfo = (message, duration = 4000) => addToast(message, 'info', duration);

    // ========================================
    // 🔒 FUNÇÕES PARA SISTEMA DE OCULTAÇÃO (FASE 2) - COM AUTENTICAÇÃO
    // ========================================

    // 🏃‍♂️ FUNÇÃO OTIMIZADA: Ocultação instantânea + notificações
    const toggleProductVisibility = async (productId, currentlyHidden = false) => {
        const action = currentlyHidden ? 'show' : 'hide';
        const productName = getProductName(productId);
        
        // 🚀 OPTIMISTIC UPDATE: Atualizar UI instantaneamente
        const originalProductsState = [...products];
        const originalTopDropsState = [...topDrops];
        
        if (action === 'hide') {
            // Remover instantaneamente da UI
            setProducts(prev => prev.filter(p => p.id !== productId));
            setTopDrops(prev => prev.filter(p => p.id !== productId));
            
            // Mostrar toast de sucesso instantâneo
            showInfo(`Produto "${productName}" foi ocultado`, 2000);
            
            console.log(`🚀 INSTANTÂNEO: Produto ${productId} removido da UI`);
        } else {
            // Para mostrar, é mais complexo, então vamos manter o comportamento atual
            showInfo('Mostrando produto...', 2000);
        }
        
        try {
            // 📡 BACKGROUND: Enviar para o banco em paralelo
            const headers = await getAuthHeaders();
            
            const response = await fetch('/api/toggle-product-visibility', {
                method: 'POST',
                headers,
                body: JSON.stringify({ productId, action })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // ✅ SUCESSO: Confirmar ação
                if (action === 'show') {
                    // Para mostrar, recarregar dados para garantir consistência
                    await fetchInitialData();
                    showSuccess(`Produto "${productName}" foi exibido novamente`);
                } else {
                    // Para ocultar, já foi feito otimisticamente
                    showSuccess(`Produto "${productName}" foi ocultado com sucesso`);
                }
                
                // Atualizar produtos ocultos se estiver carregado
                if (hiddenProducts.length > 0) {
                    await fetchHiddenProducts();
                }
                
                console.log(`✅ CONFIRMADO: ${result.message}`);
                return true;
                
            } else {
                throw new Error(result.error || 'Erro ao alterar visibilidade');
            }
            
        } catch (error) {
            console.error('❌ ERRO na ocultação:', error);
            
            // 🔄 ROLLBACK: Reverter estado original em caso de erro
            if (action === 'hide') {
                console.log('🔄 ROLLBACK: Restaurando produto na UI...');
                setProducts(originalProductsState);
                setTopDrops(originalTopDropsState);
            }
            
            // Mostrar erro com detalhes
            showError(`Erro ao ${action === 'hide' ? 'ocultar' : 'exibir'} produto: ${error.message}`);
            return false;
        }
    };
    
    // Helper para pegar nome do produto por ID
    const getProductName = (productId) => {
        const product = products.find(p => p.id === productId) || 
                       topDrops.find(p => p.id === productId) ||
                       hiddenProducts.find(p => p.id === productId);
        
        if (product) {
            const name = product.name || product.product_name || '';
            return name.length > 30 ? name.substring(0, 30) + '...' : name;
        }
        return 'Produto';
    };

    const fetchHiddenProducts = async () => {
        setLoadingHidden(true);
        try {
            const response = await fetch('/api/hidden-products');
            const result = await response.json();
            
            if (result.success) {
                setHiddenProducts(result.products || []);
            } else {
                throw new Error(result.error || 'Erro ao carregar produtos ocultos');
            }
        } catch (error) {
            console.error('Erro ao buscar produtos ocultos:', error);
            setHiddenProducts([]);
            showError(`Erro ao carregar produtos ocultos: ${error.message}`); // Toast em vez de alert
        } finally {
            setLoadingHidden(false);
        }
    };

    const fetchPriceLimits = async () => {
        try {
            const response = await fetch('/api/category-price-limits');
            const result = await response.json();
            
            if (result.success) {
                setPriceLimits(result.limits || []);
            } else {
                throw new Error(result.error || 'Erro ao carregar limites de preço');
            }
        } catch (error) {
            console.error('Erro ao buscar limites de preço:', error);
            setPriceLimits([]);
            showError(`Erro ao carregar limites de preço: ${error.message}`); // Toast em vez de alert
        }
    };

    const updatePriceLimit = async (category, maxPrice, isActive) => {
        try {
            const headers = await getAuthHeaders();
            
            // Toast de feedback instantâneo
            showInfo(`Salvando limite de preço para ${category.replace('_', ' ')}...`, 2000);

            const response = await fetch('/api/category-price-limits', {
                method: 'POST',
                headers,
                body: JSON.stringify({ 
                    category, 
                    max_price: maxPrice, 
                    is_active: isActive 
                })
            });

            const result = await response.json();
            
            if (result.success) {
                await fetchPriceLimits();
                // Recarregar produtos para refletir mudanças de visibilidade
                await fetchInitialData();
                console.log(result.message);
                showSuccess(`Limite de preço salvo com sucesso!`);
                return true;
            } else {
                throw new Error(result.error || 'Erro ao salvar limite de preço');
            }
        } catch (error) {
            console.error('Erro ao atualizar limite de preço:', error);
            showError(`Erro ao salvar limite de preço: ${error.message}`);
            return false;
        }
    };

    const toggleAllPriceLimits = async (activate) => {
        try {
            const headers = await getAuthHeaders();
            const action = activate ? 'activate_all' : 'deactivate_all';
            
            // Toast de feedback instantâneo
            showInfo(`${activate ? 'Ativando' : 'Desativando'} todos os limites...`, 2000);

            const response = await fetch('/api/toggle-all-price-limits', {
                method: 'POST',
                headers,
                body: JSON.stringify({ action })
            });

            const result = await response.json();
            
            if (result.success) {
                await fetchPriceLimits();
                // Recarregar produtos para refletir mudanças de visibilidade
                await fetchInitialData();
                console.log(result.message);
                showSuccess(result.message); // Toast em vez de alert
                return true;
            } else {
                throw new Error(result.error || 'Erro ao alterar todos os limites');
            }
        } catch (error) {
            console.error('Erro ao alterar todos os limites:', error);
            showError(`Erro ao alterar limites: ${error.message}`); // Toast em vez de alert
            return false;
        }
    };

    const showAllHiddenProducts = async () => {
        try {
            const headers = await getAuthHeaders();
            
            // Toast de feedback instantâneo
            showInfo('Mostrando todos os produtos ocultos...', 2000);

            const response = await fetch('/api/show-all-hidden-products', {
                method: 'POST',
                headers
            });

            const result = await response.json();
            
            if (result.success) {
                // Recarregar tudo para refletir mudanças
                await fetchInitialData();
                await fetchHiddenProducts();
                console.log(result.message);
                showSuccess(result.message); // Toast em vez de alert
                return true;
            } else {
                throw new Error(result.error || 'Erro ao mostrar todos os produtos');
            }
        } catch (error) {
            console.error('Erro ao mostrar todos os produtos:', error);
            showError(`Erro ao mostrar produtos: ${error.message}`); // Toast em vez de alert
            return false;
        }
    };

    return {
        // States existentes
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
        expandedBuildProduct,
        setExpandedBuildProduct,
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

        // Computed values
        getSortedProducts,
        allCategories,
        allWebsites,

        // Estados para ocultação
        showHiddenProducts,
        setShowHiddenProducts,
        hiddenProducts,
        priceLimits,
        loadingHidden,

        // Estados e funções para toast notifications
        toasts,
        addToast,
        removeToast,
        showSuccess,
        showError,
        showWarning,
        showInfo,

        // Functions existentes
        fetchPriceHistory,
        showPriceModal,
        handleIntervalChange,
        deleteProduct,
        fetchInitialData,

        // Funções para configurações de busca
        fetchSearchConfigs,
        addSearchConfig,
        toggleSearchActive,
        toggleAllSearches,
        deleteSearchConfig,
        getFilteredConfigs,

        // Funções para ocultação (com autenticação)
        toggleProductVisibility,
        fetchHiddenProducts,
        fetchPriceLimits,
        updatePriceLimit,
        toggleAllPriceLimits,      // 🆕 NOVA FUNÇÃO
        showAllHiddenProducts,     // 🆕 NOVA FUNÇÃO
    };
};
