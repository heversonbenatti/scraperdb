import { useState, useEffect } from 'react';

export const ScrapingDashboard = () => {
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchDashboardStats = async () => {
    try {
      const response = await fetch('/api/dashboard-stats');
      const data = await response.json();
      
      if (data.success) {
        setDashboardData(data);
        setLastUpdate(new Date());
        setError(null);
      } else {
        throw new Error(data.error || 'Failed to fetch dashboard data');
      }
    } catch (err) {
      console.error('Error fetching dashboard stats:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Buscar dados iniciais
    fetchDashboardStats();

    // Auto-refresh a cada 2 minutos
    const interval = setInterval(fetchDashboardStats, 2 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  const getStatusText = (status) => {
    switch (status) {
      case 'normal': return 'Normal';
      case 'baixo': return 'Baixo';
      case 'alto': return 'Alto';
      case 'offline': return 'Offline';
      case 'comentado': return 'Inativo';
      default: return 'Desconhecido';
    }
  };

  const getStatusDescription = (stat) => {
    if (stat.status === 'comentado') {
      return 'Scraper desabilitado';
    }
    if (stat.status === 'offline') {
      return 'Nenhuma atualização';
    }
    return `~${stat.averagePer30Min}/30min`;
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700 mb-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500"></div>
          <span className="ml-3 text-gray-400">Carregando status dos scrapers...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-red-500 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-red-400 mb-2">Erro no Dashboard</h3>
            <p className="text-sm text-gray-400">{error}</p>
          </div>
          <button
            onClick={fetchDashboardStats}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-md text-sm transition-colors"
          >
            Tentar Novamente
          </button>
        </div>
      </div>
    );
  }

  if (!dashboardData) {
    return null;
  }

  const { stats, summary, timestamp } = dashboardData;

  return (
    <div className="bg-gray-800 rounded-lg p-4 sm:p-6 border border-gray-700 mb-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center">
            📊 Status dos Scrapers
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Produtos atualizados nos últimos 30 minutos
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-400">
            Última atualização: {lastUpdate ? lastUpdate.toLocaleTimeString('pt-BR') : 'N/A'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Auto-refresh a cada 2 minutos
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {stats.map((stat) => (
          <div
            key={stat.website}
            className={`bg-gray-700 rounded-lg p-4 border-l-4 ${
              stat.statusColor === 'green' ? 'border-green-500' :
              stat.statusColor === 'yellow' ? 'border-yellow-500' :
              stat.statusColor === 'red' ? 'border-red-500' :
              stat.statusColor === 'blue' ? 'border-blue-500' :
              'border-gray-500'
            }`}
          >
            {/* Header do Card */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold uppercase tracking-wide">
                {stat.websiteName}
              </h3>
              <span className="text-2xl">{stat.statusIcon}</span>
            </div>

            {/* Números Principais */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Atualizados:</span>
                <span className="text-xl font-bold text-white">
                  {stat.recentCount}
                </span>
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Média histórica:</span>
                <span className="text-sm text-gray-300">
                  {getStatusDescription(stat)}
                </span>
              </div>

              {/* Status Badge */}
              <div className="pt-2">
                <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                  stat.statusColor === 'green' ? 'bg-green-600 text-green-100' :
                  stat.statusColor === 'yellow' ? 'bg-yellow-600 text-yellow-100' :
                  stat.statusColor === 'red' ? 'bg-red-600 text-red-100' :
                  stat.statusColor === 'blue' ? 'bg-blue-600 text-blue-100' :
                  'bg-gray-600 text-gray-100'
                }`}>
                  {getStatusText(stat.status)}
                </span>
              </div>

              {/* Comparação Percentual */}
              {stat.status !== 'comentado' && stat.status !== 'offline' && stat.averagePer30Min > 0 && (
                <div className="pt-1">
                  <div className="text-xs text-gray-400">
                    vs. média: {
                      ((stat.recentCount - stat.averagePer30Min) / stat.averagePer30Min * 100).toFixed(0)
                    }%
                    {stat.recentCount > stat.averagePer30Min ? ' ↗️' : ' ↘️'}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Summary Footer */}
      <div className="border-t border-gray-700 pt-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">Sites Ativos</p>
            <p className="text-lg font-bold text-purple-400">{summary.totalActiveWebsites}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">Total Atualizado</p>
            <p className="text-lg font-bold text-green-400">{summary.totalRecentUpdates}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">Média Esperada</p>
            <p className="text-lg font-bold text-blue-400">{summary.totalAverageUpdates}</p>
          </div>
        </div>
      </div>

      {/* Indicadores de Status */}
      <div className="mt-4 p-3 bg-gray-700 rounded-md">
        <p className="text-xs text-gray-400 mb-2">Legenda de Status:</p>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="flex items-center gap-1">
            <span>🟢</span> Normal (dentro da média)
          </span>
          <span className="flex items-center gap-1">
            <span>🟡</span> Baixo (&lt;70% da média)
          </span>
          <span className="flex items-center gap-1">
            <span>🔵</span> Alto (&gt;150% da média)
          </span>
          <span className="flex items-center gap-1">
            <span>🔴</span> Offline (sem atualizações)
          </span>
          <span className="flex items-center gap-1">
            <span>⚪</span> Inativo (desabilitado)
          </span>
        </div>
      </div>
    </div>
  );
};