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

    // NOVOS ESTADOS para grupos de produtos
    const [productGroups, setProductGroups] = useState([]);
    const [unclassifiedProducts, setUnclassifiedProducts] = useState([]);
    const [newGroup, setNewGroup] = useState({
        name: '',
        subcategory: ''
    });
    const [selectedGroupCategory, setSelectedGroupCategory] = useState('');
    const [groupFilters, setGroupFilters] = useState({ category: '', classified: 'unclassified' });

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

            // Buscar produtos com grupos
            const { data: productsData } = await supabaseClient
                .from('products')
                .select('*, product_groups(*)');

            // Buscar grupos de produtos
            const { data: groupsData } = await supabaseClient
                .from('product_groups')
                .select('*')
                .order('name', { ascending: true });
            setProductGroups(groupsData || []);

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
                        weightedAverage,
                    };
                })
            );

            const validProducts = productsWithPrices.filter(p => p.currentPrice > 0);
            setProducts(validProducts);

            // Separar produtos não classificados
            const unclassified = validProducts.filter(p => !p.product_group_id);
            setUnclassifiedProducts(unclassified);

            // Calcular promoções usando a nova lógica
            const promotionalProducts = await calculatePromotions(validProducts);
            setTopDrops(promotionalProducts);

            await fetchSearchConfigs();
            setLoading(false);
        } catch (error) {
            console.error('Error fetching data:', error);
            setLoading(false);
        }
    };

    // NOVAS FUNÇÕES para gerenciar grupos de produtos
    const createProductGroup = async (productId, groupData) => {
        try {
            const product = products.find(p => p.id === productId);
            if (!product) return;

            const { data: groupCreated, error: groupError } = await supabaseClient
                .from('product_groups')
                .insert([{
                    name: groupData.name,
                    category: product.category,
                    subcategory: groupData.subcategory || product.category
                }])
                .select()
                .single();

            if (groupError) throw groupError;

            // Vincular produto ao grupo
            const { error: updateError } = await supabaseClient
                .from('products')
                .update({ product_group_id: groupCreated.id })
                .eq('id', productId);

            if (updateError) throw updateError;

            // Atualizar estado local
            setProducts(prev => prev.map(p =>
                p.id === productId
                    ? { ...p, product_group_id: groupCreated.id, product_groups: groupCreated }
                    : p
            ));

            setUnclassifiedProducts(prev => prev.filter(p => p.id !== productId));
            setProductGroups(prev => [...prev, groupCreated]);

            // Limpar form
            setNewGroup({ name: '', subcategory: '' });

            return groupCreated;
        } catch (error) {
            console.error('Error creating product group:', error);
            alert('Erro ao criar grupo de produto');
        }
    };

    const assignToGroup = async (productId, groupId) => {
        try {
            const { error } = await supabaseClient
                .from('products')
                .update({ product_group_id: groupId })
                .eq('id', productId);

            if (error) throw error;

            // Buscar informações do grupo para atualizar estado local
            const { data: groupData } = await supabaseClient
                .from('product_groups')
                .select('*')
                .eq('id', groupId)
                .single();

            // Atualizar estado local
            setProducts(prev => prev.map(p =>
                p.id === productId
                    ? { ...p, product_group_id: groupId, product_groups: groupData }
                    : p
            ));

            setUnclassifiedProducts(prev => prev.filter(p => p.id !== productId));

        } catch (error) {
            console.error('Error assigning product to group:', error);
            alert('Erro ao vincular produto ao grupo');
        }
    };

    const removeFromGroup = async (productId) => {
        try {
            const { error } = await supabaseClient
                .from('products')
                .update({ product_group_id: null })
                .eq('id', productId);

            if (error) throw error;

            const product = products.find(p => p.id === productId);

            // Atualizar estado local
            setProducts(prev => prev.map(p =>
                p.id === productId
                    ? { ...p, product_group_id: null, product_groups: null }
                    : p
            ));

            if (product) {
                setUnclassifiedProducts(prev => [...prev, { ...product, product_group_id: null, product_groups: null }]);
            }

        } catch (error) {
            console.error('Error removing product from group:', error);
            alert('Erro ao remover produto do grupo');
        }
    };

    const deleteProductGroup = async (groupId) => {
        if (!confirm('Remover este grupo? Todos os produtos serão desvinculados.')) return;

        try {
            const { error } = await supabaseClient
                .from('product_groups')
                .delete()
                .eq('id', groupId);

            if (error) throw error;

            // Atualizar estado local
            setProductGroups(prev => prev.filter(g => g.id !== groupId));

            // Atualizar produtos que estavam nesse grupo
            const affectedProducts = products.filter(p => p.product_group_id === groupId);
            setProducts(prev => prev.map(p =>
                p.product_group_id === groupId
                    ? { ...p, product_group_id: null, product_groups: null }
                    : p
            ));

            setUnclassifiedProducts(prev => [...prev, ...affectedProducts.map(p => ({
                ...p,
                product_group_id: null,
                product_groups: null
            }))]);

        } catch (error) {
            console.error('Error deleting product group:', error);
            alert('Erro ao deletar grupo');
        }
    };

    // Funções de filtragem para grupos
    const getFilteredUnclassifiedProducts = useMemo(() => {
        let filtered = [...unclassifiedProducts];

        if (groupFilters.category) {
            filtered = filtered.filter(p => p.category === groupFilters.category);
        }

        // Ordenar por categoria e depois por nome
        filtered.sort((a, b) => {
            if (a.category !== b.category) {
                return a.category.localeCompare(b.category);
            }
            return a.name.localeCompare(b.name);
        });

        return filtered;
    }, [unclassifiedProducts, groupFilters.category]);

    const getFilteredGroups = useMemo(() => {
        let filtered = [...productGroups];

        if (groupFilters.category) {
            filtered = filtered.filter(g => g.category === groupFilters.category);
        }

        return filtered;
    }, [productGroups, groupFilters.category]);

    const getGroupProducts = (groupId) => {
        return products.filter(p => p.product_group_id === groupId);
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

                const isSignificantDiscount = discountPercent >= 5;
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
        // States existentes
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

        // NOVOS states para grupos
        productGroups,
        setProductGroups,
        unclassifiedProducts,
        setUnclassifiedProducts,
        newGroup,
        setNewGroup,
        selectedGroupCategory,
        setSelectedGroupCategory,
        groupFilters,
        setGroupFilters,

        // Computed values
        getSortedProducts,
        allCategories,
        allWebsites,
        getFilteredUnclassifiedProducts,
        getFilteredGroups,

        // Functions existentes
        fetchPriceHistory,
        showPriceModal,
        handleIntervalChange,
        deleteProduct,
        fetchInitialData,
        toggleFavorite,
        isFavorite,
        getFavoriteProducts,

        // NOVAS funções para grupos
        createProductGroup,
        assignToGroup,
        removeFromGroup,
        deleteProductGroup,
        getGroupProducts,
    };
};