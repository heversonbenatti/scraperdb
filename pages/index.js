import { supabase } from '../lib/supabaseClient'
import { useEffect, useState } from 'react'

export default function PriceTracker() {
  const [lowestPrices, setLowestPrices] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchLowestPrices = async () => {
      try {
        // Query to get the lowest current price for each category
        const { data, error } = await supabase
          .from('products')
          .select(`
            id,
            name,
            category,
            website,
            product_link,
            prices (price)
          `)
          .order('created_at', { foreignTable: 'prices', ascending: true })
          .limit(1, { foreignTable: 'prices' })

        if (error) throw error

        // Process the data to get the lowest price per category
        const categories = {}
        data.forEach(product => {
          if (!product.prices || product.prices.length === 0) return
          
          const currentPrice = product.prices[0].price
          if (!categories[product.category] || currentPrice < categories[product.category].price) {
            categories[product.category] = {
              name: product.name,
              price: currentPrice,
              website: product.website,
              link: product.product_link,
              category: product.category
            }
          }
        })

        setLowestPrices(Object.values(categories))
        setLoading(false)
      } catch (error) {
        console.error('Error fetching data:', error)
        setLoading(false)
      }
    }

    fetchLowestPrices()
  }, [])

  if (loading) return <div className="loading">Loading...</div>

  return (
    <div className="container">
      <h1>PC Parts Price Tracker</h1>
      <p>Lowest prices by category</p>
      
      <div className="price-grid">
        {lowestPrices.map((item, index) => (
          <div key={index} className="price-card">
            <h2>{item.category.replace('_', ' ').toUpperCase()}</h2>
            <p className="product-name">{item.name}</p>
            <p className="price">R$ {item.price.toFixed(2)}</p>
            <p className="store">Store: {item.website}</p>
            <a href={item.link} target="_blank" rel="noopener noreferrer" className="link">
              View Product
            </a>
          </div>
        ))}
      </div>

      <style jsx>{`
        .container {
          max-width: 1200px;
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
        .link {
          display: inline-block;
          margin-top: 1rem;
          color: white;
          background-color: #0070f3;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          text-decoration: none;
        }
        .link:hover {
          background-color: #005bb5;
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