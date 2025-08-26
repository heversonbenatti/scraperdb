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
    const [favoriteProducts, setFavoriteProducts] = useState([]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        fetchInitialData();

        const savedFavorites = localStorage.getItem('favoriteProducts');
        if (savedFavorites) {
            try {
                setFavoriteProducts(JSON.parse(savedFavorites));
            } catch (e) {
                console.error('Error loading favorites:', e);
            }
        }

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

    const fetchInitialData = async () => {
        if (typeof window === 'undefined') return;

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
                    // Buscar TODO o histórico de preços para cálculo correto
                    const { data: allPricesData } = await supabaseClient
                        .from('prices')
                        .select('price, collected_at, price_changed_at, last_checked_at, check_count')
                        .eq('product_id', product.id)
                        .order('price_changed_at', { ascending: false });

                    if (!allPricesData || allPricesData.length === 0) {
                        return {
                            ...product,
                            currentPrice: 0,
                            previousPrice: 0,
                            priceChange: 0,
                            lastUpdated: null
                        };
                    }

                    // 1. Preço atual (mais recente) - IGNORAR check_count
                    const currentPrice = parseFloat(allPricesData[0].price);
                    const lastUpdated = allPricesData[0].last_checked_at || allPricesData[0].collected_at;

                    // 2. Calcular mudança de 24h para compatibilidade (apenas para interface)
                    const previousPrice = allPricesData.length > 1 ? parseFloat(allPricesData[1].price) : currentPrice;
                    const priceChange = previousPrice > 0 ? ((currentPrice - previousPrice) / previousPrice * 100) : 0;

                    // 3. Calcular média histórica ponderada (EXCLUINDO o preço atual)
                    let weightedAverage = currentPrice; // Fallback se não houver histórico

                    if (allPricesData.length > 1) {
                        const historicalPrices = allPricesData.slice(1); // Remove o preço atual

                        const totalWeight = historicalPrices.reduce((sum, p) => sum + Math.max(1, p.check_count || 1), 0);
                        const weightedSum = historicalPrices.reduce((sum, p) => sum + (parseFloat(p.price) * Math.max(1, p.check_count || 1)), 0);

                        if (totalWeight > 0) {
                            weightedAverage = weightedSum / totalWeight;
                        }
                    }

                    return {
                        ...product,
                        currentPrice,
                        previousPrice,
                        priceChange,
                        lastUpdated,
                        weightedAverage, // ✅ Nova propriedade para usar em toda a aplicação
                    };
                })
            );

            setProducts(productsWithPrices.filter(p => p.currentPrice > 0));

            // Calcular promoções usando a nova lógica
            const promotionalProducts = await calculatePromotions(productsWithPrices.filter(p => p.currentPrice > 0));
            setTopDrops(promotionalProducts);

            await fetchSearchConfigs();
            setLoading(false);
        } catch (error) {
            console.error('Error fetching data:', error);
            setLoading(false);
        }
    };

    const calculatePromotions = async (productsWithPrices) => {
        const promotionalProducts = productsWithPrices.map(product => {
            try {
                // Usar weightedAverage já calculado no fetchInitialData
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

                // Calcular o desconto real baseado na sua especificação exata
                const discountPercent = ((weightedAverage - currentPrice) / weightedAverage) * 100;

                // Critérios para ser considerado promoção
                const isSignificantDiscount = discountPercent >= 5; // Mínimo 5% de desconto
                const hasMinimumPrice = currentPrice >= 20; // Preço mínimo R$ 20
                const isReasonableDiscount = discountPercent <= 80; // Máximo 80% (evita erros)

                // Calcular estatísticas adicionais para a interface
                const discountAmount = weightedAverage - currentPrice;

                const isPromotion = isSignificantDiscount &&
                    hasMinimumPrice &&
                    isReasonableDiscount &&
                    discountAmount > 0; // Garantir que é realmente um desconto

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

        // Retornar apenas produtos com promoção real, ordenados por desconto
        return promotionalProducts
            .filter(p => p.isPromotion)
            .sort((a, b) => b.promotionScore - a.promotionScore)
            .slice(0, 15); // Top 15 promoções reais
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
            const activeCount = configsWithKeywords.filter(c => c.is_active).length;
            const totalCount = configsWithKeywords.length;
            setGlobalSearchToggle(activeCount === totalCount && totalCount > 0);
        } catch (error) {
            console.error('Error fetching configs:', error);
        }
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
                // Calcular o desconto real baseado na média ponderada
                const getDiscount = (product) => {
                    if (!product.weightedAverage || product.weightedAverage === product.currentPrice) {
                        return 0;
                    }
                    // Desconto positivo = preço atual menor que média (bom)
                    // Desconto negativo = preço atual maior que média (ruim)
                    return ((product.weightedAverage - product.currentPrice) / product.weightedAverage) * 100;
                };
                
                const discountA = getDiscount(a);
                const discountB = getDiscount(b);
                
                // Ordem decrescente por padrão (maior desconto primeiro)
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
                await supabaseClient.from('prices').delete().eq('product_id', id);
                await supabaseClient.from('products').delete().eq('id', id);
                setProducts(prev => prev.filter(p => p.id !== id));

                if (selectedProduct && selectedProduct.id === id) {
                    setSelectedProduct(null);
                }

                console.log(`✅ Produto "${productName}" e seu histórico de preços foram removidos`);
            } catch (error) {
                console.error('Erro ao deletar produto:', error);
                alert('Erro ao deletar produto. Tente novamente.');
            }
        }
    };

    const toggleFavorite = (productId) => {
        setFavoriteProducts(prev => {
            let newFavorites;
            if (prev.includes(productId)) {
                newFavorites = prev.filter(id => id !== productId);
            } else {
                newFavorites = [...prev, productId];
            }
            // Salvar no localStorage
            localStorage.setItem('favoriteProducts', JSON.stringify(newFavorites));
            return newFavorites;
        });
    };

    const isFavorite = (productId) => {
        return favoriteProducts.includes(productId);
    };

    const getFavoriteProducts = useMemo(() => {
        return products.filter(p => favoriteProducts.includes(p.id));
    }, [products, favoriteProducts]);

    return {
        // States
        builds,
        setBuilds,
        products,
        loading,
        searchConfigs,
        setSearchConfigs,
        topDrops,
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

        // Functions
        fetchPriceHistory,
        showPriceModal,
        handleIntervalChange,
        deleteProduct,
        fetchInitialData,
        toggleFavorite,
        isFavorite,

        // Computed values
        getFavoriteProducts
    };
};