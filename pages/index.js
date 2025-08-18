import { supabase } from '../lib/supabaseClient'
import { useEffect, useState } from 'react'

export default function PriceTracker() {
  const [searches, setSearches] = useState([])
  const [builds, setBuilds] = useState([])
  const [selectedBuild, setSelectedBuild] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('builds')
  const [newBuild, setNewBuild] = useState({ name: '', description: '' })
  const [newSearch, setNewSearch] = useState({ 
    search_text: '', 
    keywords: '', 
    category: '', 
    subcategory: '', 
    website: 'kabum',
    link: ''
  })

  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: searchesData } = await supabase.from('searches').select('*')
        const { data: buildsData } = await supabase.from('builds').select('*')
        
        setSearches(searchesData || [])
        setBuilds(buildsData || [])
        setLoading(false)
      } catch (error) {
        console.error('Error fetching data:', error)
        setLoading(false)
      }
    }

    fetchData()

    const subscription = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, payload => {
        if (payload.table === 'searches') {
          setSearches(prev => {
            if (payload.eventType === 'DELETE') {
              return prev.filter(item => item.id !== payload.old.id)
            } else if (payload.eventType === 'INSERT') {
              return [...prev, payload.new]
            } else if (payload.eventType === 'UPDATE') {
              return prev.map(item => item.id === payload.new.id ? payload.new : item)
            }
            return prev
          })
        }
        if (payload.table === 'builds') {
          setBuilds(prev => {
            if (payload.eventType === 'DELETE') {
              return prev.filter(item => item.id !== payload.old.id)
            } else if (payload.eventType === 'INSERT') {
              return [...prev, payload.new]
            } else if (payload.eventType === 'UPDATE') {
              return prev.map(item => item.id === payload.new.id ? payload.new : item)
            }
            return prev
          })
        }
      })
      .subscribe()

    return () => supabase.removeChannel(subscription)
  }, [])

  const handleCreateBuild = async () => {
    if (!newBuild.name) {
      alert('Build name is required')
      return
    }

    const { data, error } = await supabase
      .from('builds')
      .insert([newBuild])
      .select()
    
    if (!error && data) {
      setNewBuild({ name: '', description: '' })
    }
  }

  const handleCreateSearch = async () => {
    if (!newSearch.search_text && !newSearch.link) {
      alert('Either search text or link must be provided')
      return
    }

    try {
      const keywordsArray = newSearch.keywords.split(',').map(k => k.trim())
      const formattedKeywords = JSON.stringify([keywordsArray])
      
      const { data, error } = await supabase
        .from('searches')
        .insert([{ 
          ...newSearch, 
          keywords: formattedKeywords,
          search_text: newSearch.search_text || null,
          link: newSearch.link || null
        }])
        .select()
      
      if (!error && data) {
        setNewSearch({ 
          search_text: '', 
          keywords: '', 
          category: '', 
          subcategory: '', 
          website: 'kabum',
          link: ''
        })
      }
    } catch (error) {
      console.error('Error creating search:', error)
    }
  }

  const handleDeleteBuild = async (id) => {
    await supabase.from('builds').delete().eq('id', id)
  }

  const handleDeleteSearch = async (id) => {
    await supabase.from('searches').delete().eq('id', id)
  }

  if (loading) return <div className="loading">Loading...</div>

  return (
    <div className="container">
      <div className="tabs">
        <button 
          className={activeTab === 'builds' ? 'active' : ''}
          onClick={() => setActiveTab('builds')}
        >
          Builds
        </button>
        <button 
          className={activeTab === 'searches' ? 'active' : ''}
          onClick={() => setActiveTab('searches')}
        >
          Searches
        </button>
      </div>

      {activeTab === 'builds' && (
        <div className="builds-section">
          <h2>Builds</h2>
          <div className="builds-grid">
            {builds.map(build => (
              <div key={build.id} className="build-card">
                <h3>{build.name}</h3>
                <p>{build.description}</p>
                <div className="actions">
                  <button onClick={() => setSelectedBuild(build)}>View</button>
                  <button 
                    className="delete"
                    onClick={() => handleDeleteBuild(build.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="create-build">
            <h3>Create New Build</h3>
            <input
              type="text"
              placeholder="Build Name*"
              value={newBuild.name}
              onChange={(e) => setNewBuild({...newBuild, name: e.target.value})}
              required
            />
            <input
              type="text"
              placeholder="Description"
              value={newBuild.description}
              onChange={(e) => setNewBuild({...newBuild, description: e.target.value})}
            />
            <button onClick={handleCreateBuild}>Create Build</button>
          </div>
        </div>
      )}

      {activeTab === 'searches' && (
        <div className="searches-section">
          <h2>Searches</h2>
          <table className="searches-table">
            <thead>
              <tr>
                <th>Search Text</th>
                <th>Keywords</th>
                <th>Category</th>
                <th>Subcategory</th>
                <th>Website</th>
                <th>Link</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {searches.map(search => (
                <tr key={search.id}>
                  <td>{search.search_text || '-'}</td>
                  <td>{JSON.parse(search.keywords).join(', ')}</td>
                  <td>{search.category}</td>
                  <td>{search.subcategory || '-'}</td>
                  <td>{search.website}</td>
                  <td>{search.link ? 'Yes' : 'No'}</td>
                  <td>
                    <button 
                      className="delete"
                      onClick={() => handleDeleteSearch(search.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="create-search">
            <h3>Create New Search</h3>
            <input
              type="text"
              placeholder="Search Text (or provide link below)"
              value={newSearch.search_text}
              onChange={(e) => setNewSearch({...newSearch, search_text: e.target.value})}
            />
            <input
              type="text"
              placeholder="Keywords (comma separated)*"
              value={newSearch.keywords}
              onChange={(e) => setNewSearch({...newSearch, keywords: e.target.value})}
              required
            />
            <input
              type="text"
              placeholder="Category*"
              value={newSearch.category}
              onChange={(e) => setNewSearch({...newSearch, category: e.target.value})}
              required
            />
            <input
              type="text"
              placeholder="Subcategory"
              value={newSearch.subcategory}
              onChange={(e) => setNewSearch({...newSearch, subcategory: e.target.value})}
            />
            <input
              type="text"
              placeholder="Product Link (if no search text)"
              value={newSearch.link}
              onChange={(e) => setNewSearch({...newSearch, link: e.target.value})}
            />
            <select
              value={newSearch.website}
              onChange={(e) => setNewSearch({...newSearch, website: e.target.value})}
              required
            >
              <option value="kabum">Kabum</option>
              <option value="pichau">Pichau</option>
              <option value="terabyteshop">Terabyte</option>
            </select>
            <button onClick={handleCreateSearch}>Create Search</button>
          </div>
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
        }
        .tabs {
          display: flex;
          margin-bottom: 2rem;
        }
        .tabs button {
          padding: 0.5rem 1rem;
          margin-right: 0.5rem;
          background: #eee;
          border: none;
          cursor: pointer;
        }
        .tabs button.active {
          background: #0070f3;
          color: white;
        }
        .builds-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .build-card {
          border: 1px solid #ddd;
          padding: 1rem;
          border-radius: 4px;
        }
        .build-card h3 {
          margin-top: 0;
        }
        .actions {
          display: flex;
          gap: 0.5rem;
        }
        .actions button {
          padding: 0.25rem 0.5rem;
        }
        .delete {
          background: #dc3545;
          color: white;
        }
        .create-build, .create-search {
          border-top: 1px solid #ddd;
          padding-top: 1rem;
          margin-top: 1rem;
        }
        .create-build input, 
        .create-search input, 
        .create-search select,
        .create-search textarea {
          display: block;
          margin-bottom: 0.5rem;
          padding: 0.5rem;
          width: 100%;
          max-width: 400px;
        }
        .searches-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 2rem;
        }
        .searches-table th, .searches-table td {
          padding: 0.5rem;
          border: 1px solid #ddd;
          text-align: left;
        }
        .loading {
          text-align: center;
          padding: 2rem;
        }
      `}</style>
    </div>
  )
}