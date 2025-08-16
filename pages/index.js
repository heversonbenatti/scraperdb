// index.js
import { supabase } from '../lib/supabaseClient'
import { useEffect, useState } from 'react'

export default function PriceTracker() {
  const [lowestPrices, setLowestPrices] = useState([])
  const [loading, setLoading] = useState(true)
  const [totalCost, setTotalCost] = useState(0)
  const [selectedParts, setSelectedParts] = useState({})

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
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

    // Set up realtime subscription
    const subscription = supabase
      .channel('price-changes')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'prices'
      }, payload => {
        // When a new price is inserted, update our data
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

    return () => {
      supabase.removeChannel(subscription)
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

  if (loading) return <div className="loading">Loading...</div>

  return (
    <div className="container">
      <h1>lowest prices</h1>
      
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
      </div>

      <style jsx>{`
        .container {
          max-width: 1400px;
          margin: 0 auto;
          padding: 2rem;
        }
        h1 {
          text-align: center;
          margin-bottom: 0.5rem;
        }
        p {
          text-align: center;
          margin-bottom: 2rem;
          color: #666;
        }
        .layout {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: 2rem;
        }
        .price-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 1.5rem;
        }
        .price-card {
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          transition: all 0.2s;
        }
        .price-card.selected {
          border: 2px solid #0070f3;
          background-color: #f5f9ff;
        }
        h2 {
          margin-top: 0;
          color: #333;
        }
        .product-name {
          font-weight: bold;
          margin: 0.5rem 0;
        }
        .price {
          font-size: 1.5rem;
          color: #0070f3;
          margin: 1rem 0;
        }
        .store {
          color: #666;
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
          background-color: #0070f3;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          text-decoration: none;
        }
        .link:hover {
          background-color: #005bb5;
        }
        .select-btn {
          padding: 0.5rem 1rem;
          background-color: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .select-btn:hover {
          background-color: #218838;
        }
        .build-summary {
          background-color: #f8f9fa;
          padding: 1.5rem;
          border-radius: 8px;
          height: fit-content;
          position: sticky;
          top: 1rem;
        }
        .parts-list {
          list-style: none;
          padding: 0;
          margin: 0 0 1.5rem;
        }
        .part-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.5rem 0;
          border-bottom: 1px solid #eee;
        }
        .remove-btn {
          background: none;
          border: none;
          color: #dc3545;
          cursor: pointer;
          font-size: 1.2rem;
          padding: 0 0.5rem;
        }
        .total-cost {
          display: flex;
          justify-content: space-between;
          font-size: 1.2rem;
          margin: 1rem 0;
          padding-top: 1rem;
          border-top: 1px solid #ddd;
        }
        .save-build-btn {
          width: 100%;
          padding: 0.75rem;
          background-color: #6c757d;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .save-build-btn:hover {
          background-color: #5a6268;
        }
        .loading {
          text-align: center;
          padding: 2rem;
          font-size: 1.2rem;
        }
      `}</style>
    </div>
  )
}