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
    const [promotionPeriod, setPromotionPeriod] = useState('24h'); // Novo estado para período das promoções
    const [newSearch, setNewSearch] = useState({
        search_text: '',
        keywordGroups: [''],
        category: '',
        websites: { kabum: false, pichau: false, terabyte: false },
        is_active: true
    });

    useEffect(() => {
        // Só executa no cliente (não no SSR)
        if (typeof window === 'undefined') return;

        fetchInitialData();

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
        // Só executa no cliente
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

            // Nova lógica de promoções melhorada
            const promotionalProducts = await calculatePromotions(productsWithPrices.filter(p => p.currentPrice > 0), promotionPeriod);
            setTopDrops(promotionalProducts);

            await fetchSearchConfigs();
            setLoading(false);
        } catch (error) {
            console.error('Error fetching data:', error);
            setLoading(false);
        }
    };

    const calculatePromotions = async (productsWithPrices, period = '24h') => {
        // Definir período em milissegundos
        let timeRange;
        let minDataPoints = 2; // Mínimo de pontos de dados necessários

        switch (period) {
            case '24h':
                timeRange = 24 * 60 * 60 * 1000; // 24 horas
                minDataPoints = 2;
                break;
            case '1w':
                timeRange = 7 * 24 * 60 * 60 * 1000; // 1 semana
                minDataPoints = 3;
                break;
            case '1m':
                timeRange = 30 * 24 * 60 * 60 * 1000; // 30 dias
                minDataPoints = 5;
                break;
            case 'all':
                timeRange = null; // Sem limite de tempo
                minDataPoints = 3;
                break;
            default:
                timeRange = 24 * 60 * 60 * 1000;
                minDataPoints = 2;
        }

        const promotionalProducts = await Promise.all(
            productsWithPrices.map(async (product) => {
                try {
                    // Buscar histórico baseado no período selecionado (incluindo check_count)
                    let query = supabaseClient
                        .from('prices')
                        .select('price, price_changed_at, check_count')
                        .eq('product_id', product.id)
                        .order('price_changed_at', { ascending: false });

                    // Aplicar filtro de tempo se não for "desde sempre"
                    if (timeRange) {
                        const startDate = new Date(Date.now() - timeRange).toISOString();
                        query = query.gte('price_changed_at', startDate);
                    }

                    const { data: historicalPrices } = await query;

                    if (!historicalPrices || historicalPrices.length < minDataPoints) {
                        return { ...product, isPromotion: false, promotionScore: 0, period };
                    }

                    const prices = historicalPrices.map(p => parseFloat(p.price)).filter(p => p > 0);
                    const pricesWithWeight = historicalPrices.map(p => ({
                        price: parseFloat(p.price),
                        weight: Math.max(1, p.check_count || 1), // Peso baseado no check_count
                        date: p.price_changed_at
                    })).filter(p => p.price > 0);

                    const currentPrice = product.currentPrice;

                    if (prices.length < minDataPoints || pricesWithWeight.length < minDataPoints) {
                        return { ...product, isPromotion: false, promotionScore: 0, period };
                    }

                    // **FIX: Calcular baseline considerando o peso (check_count) dos preços**
                    const historicalPricesWithWeight = pricesWithWeight.slice(1); // Remove o primeiro (atual)

                    if (historicalPricesWithWeight.length === 0) {
                        return { ...product, isPromotion: false, promotionScore: 0, period };
                    }

                    let baseline, discountThreshold;

                    if (period === '24h') {
                        // Para 24h, usa preço ponderado mais comum (maior peso)
                        const maxWeight = Math.max(...historicalPricesWithWeight.map(p => p.weight));
                        const stablePrices = historicalPricesWithWeight.filter(p => p.weight >= maxWeight * 0.5);
                        baseline = stablePrices.length > 0 ?
                            Math.max(...stablePrices.map(p => p.price)) :
                            Math.max(...historicalPricesWithWeight.map(p => p.price));
                        discountThreshold = 5;
                    } else {
                        // Para períodos maiores, usa média ponderada dos preços estáveis
                        const totalWeight = historicalPricesWithWeight.reduce((sum, p) => sum + p.weight, 0);
                        const weightedSum = historicalPricesWithWeight.reduce((sum, p) => sum + (p.price * p.weight), 0);
                        baseline = weightedSum / totalWeight;
                        discountThreshold = period === '1w' ? 8 : 10;
                    }

                    // **FIX: Verificar estabilidade usando check_count**
                    const discountPercent = ((baseline - currentPrice) / baseline) * 100;

                    // **FIX: Validação adicional baseada na estabilidade dos preços**
                    if (discountPercent > 30) {
                        // Se desconto > 30%, verificar se os preços altos foram estáveis
                        const currentPriceWeight = pricesWithWeight[0]?.weight || 1;
                        const avgHistoricalWeight = historicalPricesWithWeight.length > 0 ?
                            historicalPricesWithWeight.reduce((sum, p) => sum + p.weight, 0) / historicalPricesWithWeight.length : 1;

                        // Se o preço atual tem muito mais verificações que os históricos, pode ser erro nos históricos
                        if (currentPriceWeight > avgHistoricalWeight * 3) {
                            return { ...product, isPromotion: false, promotionScore: 0, period };
                        }

                        // Verificar se existem preços próximos ao atual com bom peso
                        const currentPriceTolerance = currentPrice * 0.1; // 10% de tolerância
                        const similarStablePrices = historicalPricesWithWeight.filter(p =>
                            Math.abs(p.price - currentPrice) <= currentPriceTolerance && p.weight >= 2
                        );

                        // Se há preços similares e estáveis ao atual, provavelmente não é promoção
                        if (similarStablePrices.length > 0) {
                            return { ...product, isPromotion: false, promotionScore: 0, period };
                        }
                    }

                    const finalDiscountPercent = ((baseline - currentPrice) / baseline) * 100;
                    const historicalLow = Math.min(...prices);
                    const historicalHigh = Math.max(...prices);

                    // Critérios ajustados considerando estabilidade
                    const isSignificantDiscount = finalDiscountPercent >= discountThreshold;
                    const hasMinimumPrice = currentPrice >= (period === '24h' ? 20 : 50);
                    const isNearLow = currentPrice <= historicalLow * 1.15;
                    const isReasonableDiscount = finalDiscountPercent <= 70; // Máximo 70% considerando estabilidade

                    // **FIX: Verificar se o preço atual tem estabilidade mínima**
                    const currentStability = pricesWithWeight[0]?.weight || 1;
                    const hasMinimumStability = currentStability >= 1;

                    const isPromotion = isSignificantDiscount && hasMinimumPrice &&
                        (isNearLow || prices.length >= 5) && isReasonableDiscount && hasMinimumStability;

                    return {
                        ...product,
                        isPromotion,
                        promotionScore: Math.round(Math.max(0, finalDiscountPercent)),
                        baseline,
                        historicalLow,
                        historicalHigh,
                        priceHistory: prices.length,
                        period,
                        // Dados adicionais para interface
                        priceRange: historicalHigh - historicalLow,
                        discountAmount: baseline - currentPrice
                    };
                } catch (error) {
                    console.error(`Error calculating promotion for product ${product.id}:`, error);
                    return { ...product, isPromotion: false, promotionScore: 0, period };
                }
            })
        );

        return promotionalProducts
            .filter(p => p.isPromotion)
            .sort((a, b) => b.promotionScore - a.promotionScore)
            .slice(0, 10);
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
                comparison = a.priceChange - b.priceChange;
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
        promotionPeriod,
        setPromotionPeriod,

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
        calculatePromotions
    };
};