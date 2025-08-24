export const Layout = ({ children, activeTab, setActiveTab, userRole, handleLogin, handleLogout, showLogin, setShowLogin, loginCreds, setLoginCreds }) => {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
          <div className="flex items-center justify-between h-14 sm:h-16">
            {/* Logo/Title - Smaller on mobile */}
            <div className="flex items-center space-x-2 sm:space-x-8">
              <h1 className="text-lg sm:text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                🖥️ PC Scraper
              </h1>
              
              {/* Desktop Navigation */}
              <nav className="hidden md:flex space-x-4">
                {['home', 'builds', 'products', ...(userRole === 'admin' ? ['admin'] : [])].map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === tab
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                      }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </nav>
            </div>

            {/* Mobile Menu Button + Auth Button */}
            <div className="flex items-center space-x-2">
              {/* Auth Button - Always visible */}
              {userRole === 'admin' ? (
                <button
                  onClick={handleLogout}
                  className="px-2 sm:px-4 py-2 bg-red-600 hover:bg-red-700 rounded-md text-xs sm:text-sm font-medium transition-colors"
                >
                  Sair
                </button>
              ) : (
                <button
                  onClick={() => setShowLogin(true)}
                  className="px-2 sm:px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md text-xs sm:text-sm font-medium transition-colors"
                >
                  Admin
                </button>
              )}
            </div>
          </div>

          {/* Mobile Navigation */}
          <div className="md:hidden pb-3">
            <div className="flex flex-wrap gap-2">
              {['home', 'builds', 'products', ...(userRole === 'admin' ? ['admin'] : [])].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-2 rounded-md text-xs font-medium transition-colors ${activeTab === tab
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                    }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8 py-4 sm:py-8">
        {children}
      </main>

      {/* Login Modal */}
      {showLogin && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 w-full max-w-md animate-slide-up">
            <h2 className="text-lg sm:text-xl font-bold mb-4">Login Admin</h2>
            <form onSubmit={handleLogin} className="space-y-4">
              <input
                type="email"
                placeholder="Email"
                value={loginCreds.email}
                onChange={(e) => setLoginCreds({ ...loginCreds, email: e.target.value })}
                className="w-full px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                required
              />
              <input
                type="password"
                placeholder="Senha"
                value={loginCreds.password}
                onChange={(e) => setLoginCreds({ ...loginCreds, password: e.target.value })}
                className="w-full px-3 sm:px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                required
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 px-3 sm:px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-md font-medium transition-colors text-sm sm:text-base"
                >
                  Entrar
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogin(false)}
                  className="flex-1 px-3 sm:px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-md font-medium transition-colors text-sm sm:text-base"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};