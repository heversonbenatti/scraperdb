// index.js
import { supabase } from '../lib/supabaseClient'
import { useEffect, useState } from 'react'

export default function PriceTracker() {
  const [lowestPrices, setLowestPrices] = useState([])
  const [loading, setLoading] = useState(true)
  const [totalCost, setTotalCost] = useState(0)
  const [selectedParts, setSelectedParts] = useState({})
  const [searchConfigs, setSearchConfigs] = useState([])
  const [newSearch, setNewSearch] = useState({
    search_text: '',
    keywords: '',
    category: '',
    website: 'kabum',
    is_active: true
  })

  // Fetch initial data
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Fetch products and prices
        const { data: productsData, error: productsError } = await supabase
          .from('products')
          .select(`
            id,
            name,
            category,
            website,
            product_link
          `)

        if (productsError) throw productsError

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
        })

        const productsWithPrices = await Promise.all(pricesPromises)
        updateLowestPrices(productsWithPrices)
        
        // Fetch search configurations
        const { data: configsData, error: configsError } = await supabase
          .from('search_configs')
          .select('*')
          .order('created_at', { ascending: false })
        
        if (!configsError) setSearchConfigs(configsData)
        
        setLoading(false)
      } catch (error) {
        console.error('Error fetching data:', error)
        setLoading(false)
      }
    }

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

    // Initial fetch
    fetchInitialData()

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
      }, payload => {
        if (payload.eventType === 'INSERT') {
          setSearchConfigs(prev => [payload.new, ...prev])
        } else if (payload.eventType === 'UPDATE') {
          setSearchConfigs(prev => prev.map(config => 
            config.id === payload.new.id ? payload.new : config
          ))
        } else if (payload.eventType === 'DELETE') {
          setSearchConfigs(prev => prev.filter(config => config.id !== payload.old.id))
        }
      })
      .subscribe()

    return () => {
      supabase.removeChannel(productsSubscription)
      supabase.removeChannel(configsSubscription)
    }
  }, [])

  // Calculate total cost when selected parts change
  useEffect(() => {
    const sum = Object.values(selectedParts).reduce((total, part) => total + part.price, 0)
    setTotalCost(sum)
  }, [selectedParts])

  const handleSelectPart = (part) => {
    setSelectedParts(prev => ({
      ...prev,
      [part.category]: part
    }))
  }

  const handleRemovePart = (category) => {
    setSelectedParts(prev => {
      const newParts = { ...prev }
      delete newParts[category]
      return newParts
    })
  }

  // Search configuration functions
  const addSearchConfig = async () => {
    if (!newSearch.search_text || !newSearch.keywords || !newSearch.category) {
      alert('Preencha todos os campos obrigatórios')
      return
    }

    const keywordsArray = newSearch.keywords
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0)
    
    if (keywordsArray.length === 0) {
      alert('Adicione pelo menos uma keyword')
      return
    }

    const formattedKeywords = [keywordsArray]

    const { data, error } = await supabase
      .from('search_configs')
      .insert([{
        search_text: newSearch.search_text,
        keywords: JSON.stringify(formattedKeywords),
        category: newSearch.category,
        website: newSearch.website,
        is_active: newSearch.is_active
      }])
      .select()

    if (!error) {
      setNewSearch({
        search_text: '',
        keywords: '',
        category: '',
        website: 'kabum',
        is_active: true
      })
    } else {
      console.error('Error adding search config:', error)
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
    const { error } = await supabase
      .from('search_configs')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting search config:', error)
    }
  }

  if (loading) return <div className="loading">Loading...</div>

  return (
    <div className="container">
      <h1>PC Part Price Tracker</h1>
      
      <div className="layout">
        <div className="price-grid">
          {lowestPrices.map((item, index) => (
            <div key={index} className={`price-card ${selectedParts[item.category] ? 'selected' : ''}`}>
              <h2>{item.category.replace('_', ' ').toUpperCase()}</h2>
              <p className="product-name">{item.name}</p>
              <p className="price">R$ {item.price.toFixed(2)}</p>
              <p className="store">Store: {item.website}</p>
              <div className="actions">
                <a href={item.link} target="_blank" rel="noopener noreferrer" className="link">
                  View Product
                </a>
                <button 
                  onClick={() => handleSelectPart(item)}
                  className="select-btn"
                >
                  {selectedParts[item.category] ? 'Selected' : 'Select'}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="build-summary">
          <h2>Your Build</h2>
          <ul className="parts-list">
            {Object.entries(selectedParts).map(([category, part]) => (
              <li key={category} className="part-item">
                <span>{category.replace('_', ' ')}: {part.name}</span>
                <span>R$ {part.price.toFixed(2)}</span>
                <button 
                  onClick={() => handleRemovePart(category)}
                  className="remove-btn"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="total-cost">
            <span>Total:</span>
            <span>R$ {totalCost.toFixed(2)}</span>
          </div>
          <button className="save-build-btn">Save Build</button>
        </div>
      </div>

      <div className="search-management">
        <h2>Manage Search Configurations</h2>
        
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
            <label>Keywords (comma separated):</label>
            <input 
              type="text" 
              value={newSearch.keywords}
              onChange={(e) => setNewSearch({...newSearch, keywords: e.target.value})}
              placeholder="Ex: x3d, 5500, processador"
            />
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
            <label>Website:</label>
            <select 
              value={newSearch.website}
              onChange={(e) => setNewSearch({...newSearch, website: e.target.value})}
            >
              <option value="kabum">Kabum</option>
              <option value="pichau">Pichau</option>
              <option value="terabyte">Terabyte</option>
            </select>
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
                <th>Keywords</th>
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
                  <td>{JSON.parse(config.keywords)[0].join(', ')}</td>
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

      <style jsx>{`
  body {
    background-color: #121212;
    color: #e0e0e0;
  }
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
    color: #e0e0e0;
  }
  h1, h2, h3 {
    color: #ffffff;
  }
  .price-card {
    border: 1px solid #333;
    background-color: #1e1e1e;
    color: #e0e0e0;
  }
  .price-card.selected {
    border: 2px solid #0070f3;
    background-color: #1a2a3a;
  }
  .price {
    color: #4dabf7;
  }
  .store {
    color: #a5a5a5;
  }
  .link {
    background-color: #1971c2;
    color: white;
  }
  .link:hover {
    background-color: #1864ab;
  }
  .build-summary {
    background-color: #1e1e1e;
    color: #e0e0e0;
    border: 1px solid #333;
  }
  .part-item {
    border-bottom: 1px solid #333;
  }
  .total-cost {
    border-top: 1px solid #333;
  }
  .save-build-btn {
    background-color: #495057;
    color: white;
  }
  .save-build-btn:hover {
    background-color: #3e444a;
  }
  .search-management {
    background-color: #1e1e1e;
    border: 1px solid #333;
  }
  .add-search-form {
    background-color: #252525;
    color: #e0e0e0;
    border: 1px solid #333;
  }
  .form-group input,
  .form-group select {
    background-color: #333;
    color: #e0e0e0;
    border: 1px solid #444;
  }
  .search-configs-list {
    background-color: #252525;
    border: 1px solid #333;
  }
  table {
    color: #e0e0e0;
  }
  th, td {
    border-bottom: 1px solid #333;
  }
  /* Ajustes para os botões no dark mode */
  .select-btn {
    background-color: #2b8a3e;
    color: white;
  }
  .select-btn:hover {
    background-color: #2f9e44;
  }
  .remove-btn {
    color: #ff6b6b;
  }
  .add-btn {
    background-color: #2b8a3e;
    color: white;
  }
  .add-btn:hover {
    background-color: #2f9e44;
  }
  .status-btn.active {
    background-color: #2b8a3e;
  }
  .status-btn.inactive {
    background-color: #c92a2a;
  }
  .delete-btn {
    background-color: #c92a2a;
  }
`}</style>
    </div>
  )
}