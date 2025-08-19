// index.js
import { supabase } from '../lib/supabaseClient';
import { useEffect, useState } from 'react';
import Login from '../components/login';

export default function PriceTracker() {
  const [userRole, setUserRole] = useState(null); // 'admin', 'guest', or null
  const [builds, setBuilds] = useState([]);
  const [lowestPrices, setLowestPrices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchConfigs, setSearchConfigs] = useState([]);
  const [newSearch, setNewSearch] = useState({
    search_text: '',
    keywordGroups: [''], // Array of keyword group strings
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
  const [selectedBuild, setSelectedBuild] = useState(null);
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
        updateLowestPrices(productsWithPrices)
        
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

    const updateLowestPrices = (products) => {
      const categories = {}
      products.forEach(product => {
        if (!categories[product.category] || 
            product.price < categories[product.category].price) {
          categories[product.category] = {
            id: product.id,
            name: product.name,
            price: product.price,
            website: product.website,
            link: product.product_link,
            category: product.category
          }
        }
      })
      setLowestPrices(Object.values(categories))
    }

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
        setLowestPrices(prev => {
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

  // Calculate total price for a build
  const calculateBuildTotal = (buildCategories) => {
    if (!buildCategories || !lowestPrices.length) return 0
    
    return buildCategories.reduce((total, category) => {
      const categoryItem = lowestPrices.find(item => item.category === category)
      return total + (categoryItem?.price || 0)
    }, 0)
  }

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

  if (!userRole) {
    return (
      <Login 
        onLogin={(role) => setUserRole(role)} 
        onGuest={(role) => setUserRole(role)} 
      />
    );
  }

  if (loading) return <div className="loading">Loading...</div>

  if (selectedBuild) {
    // View for a specific build
    const buildCategories = selectedBuild.categories || []
    const buildItems = buildCategories.map(category => 
      lowestPrices.find(item => item.category === category))
    const totalPrice = calculateBuildTotal(buildCategories)

    return (
      <div className={`container ${userRole === 'guest' ? 'guest-view' : ''}`}>
        <div className="header">
          <div className="build-header">
            <h1>{selectedBuild.name}</h1>
            <div>
              <button 
                onClick={() => setSelectedBuild(null)}
                className="back-btn"
              >
                Back to Builds
              </button>
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
          </div>
        </div>
        
        <div className="price-grid">
          {buildItems.filter(Boolean).map((item, index) => (
            <div key={index} className="price-card">
              <h2>{item.category.replace('_', ' ').toUpperCase()}</h2>
              <p className="product-name">{item.name}</p>
              <p className="price">R$ {item.price.toFixed(2)}</p>
              <p className="store">Store: {item.website}</p>
              <div className="actions">
                <a href={item.link} target="_blank" rel="noopener noreferrer" className="link">
                  View Product
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="build-total">
          <h2>Total: R$ {totalPrice.toFixed(2)}</h2>
        </div>

        <style jsx>{`
          .build-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
          }
          .back-btn {
            background-color: #333;
            color: white;
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            margin-right: 1rem;
          }
          .build-total {
            text-align: right;
            margin-top: 2rem;
            padding: 1rem;
            background-color: #1e1e1e;
            border-radius: 8px;
          }
          .build-total h2 {
            margin: 0;
            color: #4dabf7;
          }
          .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
            color: #e0e0e0;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
          }
          h1 {
            text-align: center;
            margin-bottom: 0.5rem;
            color: #ffffff;
          }
          .price-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
          }
          .price-card {
            border: 1px solid #333;
            border-radius: 8px;
            padding: 1.5rem;
            background-color: #1e1e1e;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            transition: all 0.2s;
            color: #e0e0e0;
          }
          .price-card h2 {
            margin-top: 0;
            color: #ffffff;
          }
          .product-name {
            font-weight: bold;
            margin: 0.5rem 0;
            color: #ffffff;
          }
          .price {
            font-size: 1.5rem;
            color: #4dabf7;
            margin: 1rem 0;
          }
          .store {
            color: #a5a5a5;
            margin: 0.5rem 0;
          }
          .actions {
            display: flex;
            justify-content: space-between;
            margin-top: 1rem;
          }
          .link {
            display: inline-block;
            color: white;
            background-color: #1971c2;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            text-decoration: none;
            transition: background-color 0.2s;
            width: 100%;
            text-align: center;
          }
          .link:hover {
            background-color: #1864ab;
          }
          .loading {
            text-align: center;
            padding: 2rem;
            font-size: 1.2rem;
            color: #e0e0e0;
          }
          .logout-btn {
            background-color: #c92a2a;
            color: white;
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }
        `}</style>
      </div>
    )
  }

  // Main view with builds list
  return (
    <div className={`container ${userRole === 'guest' ? 'guest-view' : ''}`}>
      <div className="header">
        <h1>pc scraper</h1>
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
      
      <div className="builds-section">
        <div className="builds-header">
          <h2>BUILDS</h2>
          {userRole === 'admin' && (
            <button 
              onClick={() => setShowBuildForm(!showBuildForm)}
              className="add-build-btn"
            >
              {showBuildForm ? 'Cancel' : 'Add New Build'}
            </button>
          )}
        </div>

        {showBuildForm && userRole === 'admin' && (
          <div className="build-form">
            <div className="form-group">
              <label>Build Name:</label>
              <input 
                type="text" 
                value={newBuild.name}
                onChange={(e) => setNewBuild({...newBuild, name: e.target.value})}
                placeholder="Ex: Gaming PC 2023"
              />
            </div>
            
            <div className="form-group">
              <label>Select Categories:</label>
              <div className="category-checkboxes">
                {lowestPrices.map(item => (
                  <label key={item.category}>
                    <input
                      type="checkbox"
                      checked={newBuild.categories.includes(item.category)}
                      onChange={() => toggleCategoryInBuild(item.category)}
                    />
                    {item.category.replace('_', ' ').toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
            
            <button onClick={createBuild} className="create-btn">
              Create Build
            </button>
          </div>
        )}

        <div className="builds-grid">
          {builds.map(build => {
            const totalPrice = calculateBuildTotal(build.categories)
            return (
              <div key={build.id} className="build-card">
                <div className="build-card-header">
                  <h3 onClick={() => setSelectedBuild(build)} className="build-name">
                    {build.name}
                  </h3>
                  {userRole === 'admin' && (
                    <button 
                      onClick={() => deleteBuild(build.id)}
                      className="delete-btn"
                    >
                      Remove
                    </button>
                  )}
                </div>
                
                <div className="build-categories">
                  {build.categories.map((category, index) => (
                    <span key={index} className="category-tag">
                      {category.replace('_', ' ').toUpperCase()}
                    </span>
                  ))}
                </div>
                
                <div className="build-total">
                  Total: R$ {totalPrice.toFixed(2)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {userRole === 'admin' && (
        <div className="search-management">
          <h2>SEARCHES</h2>
          
          <div className="add-search-form">
            <h3>Add New Search</h3>
            <div className="form-group">
              <label>Search Term:</label>
              <input 
                type="text" 
                value={newSearch.search_text}
                onChange={(e) => setNewSearch({...newSearch, search_text: e.target.value})}
                placeholder="Ex: amd ryzen 5"
              />
            </div>
            
            <div className="form-group">
              <label>Keyword Groups:</label>
              {newSearch.keywordGroups.map((group, index) => (
                <div key={index} className="keyword-group-input">
                  <input 
                    type="text" 
                    value={group}
                    onChange={(e) => updateKeywordGroup(index, e.target.value)}
                    placeholder="Ex: x3d,5500,processador"
                  />
                  {newSearch.keywordGroups.length > 1 && (
                    <button 
                      type="button" 
                      onClick={() => removeKeywordGroup(index)}
                      className="remove-group-btn"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button 
                type="button" 
                onClick={addKeywordGroup}
                className="add-group-btn"
              >
                Add Keyword Group
              </button>
              <div className="helper-text">
                Each keyword group should contain comma-separated keywords. All keywords in a group must match for the product to be selected.
              </div>
            </div>
            
            <div className="form-group">
              <label>Category:</label>
              <input 
                type="text" 
                value={newSearch.category}
                onChange={(e) => setNewSearch({...newSearch, category: e.target.value})}
                placeholder="Ex: cpu_2"
              />
            </div>
            
            <div className="form-group">
              <label>Websites:</label>
              <div className="website-checkboxes">
                <label>
                  <input
                    type="checkbox"
                    checked={newSearch.websites.kabum}
                    onChange={(e) => setNewSearch({
                      ...newSearch,
                      websites: {
                        ...newSearch.websites,
                        kabum: e.target.checked
                      }
                    })}
                  />
                  Kabum
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={newSearch.websites.pichau}
                    onChange={(e) => setNewSearch({
                      ...newSearch,
                      websites: {
                        ...newSearch.websites,
                        pichau: e.target.checked
                      }
                    })}
                  />
                  Pichau
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={newSearch.websites.terabyte}
                    onChange={(e) => setNewSearch({
                      ...newSearch,
                      websites: {
                        ...newSearch.websites,
                        terabyte: e.target.checked
                      }
                    })}
                  />
                  Terabyte
                </label>
              </div>
            </div>
            
            <div className="form-group">
              <label>
                <input 
                  type="checkbox" 
                  checked={newSearch.is_active}
                  onChange={(e) => setNewSearch({...newSearch, is_active: e.target.checked})}
                />
                Active
              </label>
            </div>
            
            <button onClick={addSearchConfig} className="add-btn">
              Add Search
            </button>
          </div>
          
          <div className="search-configs-list">
            <h3>Configured Searches</h3>
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Keyword Groups</th>
                  <th>Category</th>
                  <th>Website</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {searchConfigs.map(config => (
                  <tr key={config.id}>
                    <td>{config.search_text}</td>
                    <td>
                      <div className="keyword-groups-display">
                        {config.keywordGroups.map((group, groupIdx) => (
                          <div key={groupIdx} className="keyword-group-display">
                            {group}
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>{config.category}</td>
                    <td>{config.website}</td>
                    <td>
                      <button 
                        onClick={() => toggleSearchActive(config.id, config.is_active)}
                        className={`status-btn ${config.is_active ? 'active' : 'inactive'}`}
                      >
                        {config.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td>
                      <button 
                        onClick={() => deleteSearchConfig(config.id)}
                        className="delete-btn"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 1400px;
          margin: 0 auto;
          padding: 2rem;
          color: #e0e0e0;
        }
        .guest-view .admin-only {
          display: none;
        }
        .guest-view .delete-btn,
        .guest-view .add-btn,
        .guest-view .create-btn,
        .guest-view .status-btn,
        .guest-view input[type="checkbox"],
        .guest-view input[type="text"] {
          display: none;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
        }
        h1, h2, h3 {
          color: #ffffff;
        }
        .builds-section {
          margin-bottom: 3rem;
        }
        .builds-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .add-build-btn {
          background-color: #1971c2;
          color: white;
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .build-form {
          background-color: #1e1e1e;
          padding: 1.5rem;
          border-radius: 8px;
          margin-bottom: 2rem;
          border: 1px solid #333;
        }
        .form-group {
          margin-bottom: 1rem;
        }
        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: bold;
          color: #e0e0e0;
        }
        .form-group input {
          width: 100%;
          padding: 0.5rem;
          background-color: #333;
          color: #e0e0e0;
          border: 1px solid #444;
          border-radius: 4px;
        }
        .keyword-group-input {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
          align-items: center;
        }
        .keyword-group-input input {
          flex: 1;
        }
        .remove-group-btn {
          background-color: #c92a2a;
          color: white;
          padding: 0.25rem 0.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
        }
        .add-group-btn {
          background-color: #1971c2;
          color: white;
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 0.5rem;
        }
        .category-checkboxes {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 0.5rem;
          margin-top: 0.5rem;
        }
        .category-checkboxes label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
        }
        .create-btn {
          background-color: #2b8a3e;
          color: white;
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 1rem;
        }
        .builds-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 1.5rem;
        }
        .build-card {
          border: 1px solid #333;
          border-radius: 8px;
          padding: 1.5rem;
          background-color: #1e1e1e;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .build-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .build-name {
          margin: 0;
          cursor: pointer;
          color: #4dabf7;
        }
        .build-name:hover {
          text-decoration: underline;
        }
        .build-categories {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 1rem;
        }
        .category-tag {
          background-color: #333;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.8rem;
        }
        .build-total {
          font-weight: bold;
          color: #ffffff;
          margin-top: 1rem;
        }
        .delete-btn {
          background-color: #c92a2a;
          color: white;
          padding: 0.25rem 0.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .search-management {
          margin-top: 3rem;
          padding: 2rem;
          background-color: #1e1e1e;
          border-radius: 8px;
          border: 1px solid #333;
        }
        .add-search-form {
          margin-bottom: 2rem;
          padding: 1.5rem;
          background-color: #252525;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          color: #e0e0e0;
          border: 1px solid #333;
        }
        .website-checkboxes {
          display: flex;
          gap: 1rem;
          margin-top: 0.5rem;
        }
        .website-checkboxes label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
        }
        .helper-text {
          font-size: 0.8rem;
          color: #a5a5a5;
          margin-top: 0.25rem;
        }
        .add-btn {
          background-color: #2b8a3e;
          color: white;
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 1rem;
        }
        .search-configs-list {
          background-color: #252525;
          padding: 1.5rem;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          border: 1px solid #333;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          color: #e0e0e0;
        }
        th, td {
          padding: 0.75rem;
          text-align: left;
          border-bottom: 1px solid #333;
        }
        th {
          background-color: #333;
        }
        .keyword-groups-display {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .keyword-group-display {
          background-color: #333;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.85rem;
          display: inline-block;
          margin-right: 0.25rem;
        }
        .status-btn {
          padding: 0.25rem 0.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .status-btn.active {
          background-color: #2b8a3e;
          color: white;
        }
        .status-btn.inactive {
          background-color: #c92a2a;
          color: white;
        }
        .loading {
          text-align: center;
          padding: 2rem;
          font-size: 1.2rem;
          color: #e0e0e0;
        }
        .logout-btn {
          background-color: #c92a2a;
          color: white;
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
      `}</style>
    </div>
  )
}