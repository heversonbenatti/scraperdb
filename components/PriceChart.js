export const PriceChart = ({ data, className = "", interval = "1d" }) => {
  if (!data || data.length === 0) {
    return (
      <div className={`flex items-center justify-center h-48 text-gray-400 ${className}`}>
        Sem dados de histórico disponíveis
      </div>
    );
  }

  // Função para gerar pontos de tempo fixos + mudanças reais
  const generateTimelineData = (rawData, interval) => {
    const now = new Date();
    let timelineData = [];
    let intervalMs, pointCount, timeRange;

    // Configurações para cada intervalo
    switch (interval) {
      case '1h': // 1 hora de intervalo, últimas 24 horas
        intervalMs = 60 * 60 * 1000; // 1 hora em ms
        pointCount = 24;
        timeRange = 24 * 60 * 60 * 1000; // 24 horas em ms
        break;
      case '6h': // 6 horas de intervalo, últimos 6 dias
        intervalMs = 6 * 60 * 60 * 1000; // 6 horas em ms
        pointCount = 24;
        timeRange = 6 * 24 * 60 * 60 * 1000; // 6 dias em ms
        break;
      case '1d': // 1 dia de intervalo, últimos 30 dias
        intervalMs = 24 * 60 * 60 * 1000; // 1 dia em ms
        pointCount = 30;
        timeRange = 30 * 24 * 60 * 60 * 1000; // 30 dias em ms
        break;
      case '1w': // 1 semana de intervalo, últimos 3 meses
        intervalMs = 7 * 24 * 60 * 60 * 1000; // 1 semana em ms
        pointCount = 12;
        timeRange = 3 * 30 * 24 * 60 * 60 * 1000; // ~3 meses em ms
        break;
      default:
        intervalMs = 24 * 60 * 60 * 1000;
        pointCount = 30;
        timeRange = 30 * 24 * 60 * 60 * 1000;
    }

    // Ordenar dados por timestamp
    const sortedData = [...rawData].sort((a, b) => 
      new Date(a.price_changed_at || a.collected_at) - new Date(b.price_changed_at || b.collected_at)
    );

    // Filtrar dados dentro do período + último preço anterior (se não houver dados no período)
    const cutoffTime = new Date(now.getTime() - timeRange);
    const relevantData = sortedData.filter(item => {
      const itemTime = new Date(item.price_changed_at || item.collected_at);
      return itemTime >= cutoffTime;
    });

    // Se não há dados no período, buscar o último preço conhecido antes do período
    let lastKnownPrice = null;
    if (relevantData.length === 0 && sortedData.length > 0) {
      // Encontrar o último preço antes do período de tempo
      for (let i = sortedData.length - 1; i >= 0; i--) {
        const itemTime = new Date(sortedData[i].price_changed_at || sortedData[i].collected_at);
        if (itemTime < cutoffTime) {
          lastKnownPrice = sortedData[i].price;
          break;
        }
      }
      // Se não encontrou nenhum antes do período, usar o primeiro disponível
      if (lastKnownPrice === null) {
        lastKnownPrice = sortedData[0].price;
      }
    }

    // Gerar pontos de tempo fixos
    const fixedPoints = [];
    for (let i = pointCount - 1; i >= 0; i--) {
      const pointTime = new Date(now.getTime() - (i * intervalMs));
      fixedPoints.push({
        timestamp: pointTime,
        isFixed: true
      });
    }

    // Adicionar mudanças reais de preço
    const realChanges = relevantData.map(item => ({
      timestamp: new Date(item.price_changed_at || item.collected_at),
      price: item.price,
      isFixed: false,
      isActualChange: true
    }));

    // Combinar pontos fixos e mudanças reais
    const allPoints = [...fixedPoints, ...realChanges];

    // Ordenar todos os pontos por timestamp
    allPoints.sort((a, b) => a.timestamp - b.timestamp);

    // Remover duplicatas muito próximas (dentro de 5% do intervalo)
    const tolerance = intervalMs * 0.05;
    const filteredPoints = [];
    
    for (let i = 0; i < allPoints.length; i++) {
      const point = allPoints[i];
      
      // Verificar se já existe um ponto muito próximo
      const isDuplicate = filteredPoints.some(existing => 
        Math.abs(point.timestamp.getTime() - existing.timestamp.getTime()) < tolerance
      );

      if (!isDuplicate) {
        filteredPoints.push(point);
      }
    }

    // Calcular preços para todos os pontos
    for (let point of filteredPoints) {
      if (!point.price) {
        // Encontrar o preço mais recente antes ou no momento deste ponto
        let priceAtPoint = null;
        
        // Primeiro, tentar encontrar nos dados relevantes (dentro do período)
        for (let j = relevantData.length - 1; j >= 0; j--) {
          const dataTime = new Date(relevantData[j].price_changed_at || relevantData[j].collected_at);
          if (dataTime <= point.timestamp) {
            priceAtPoint = relevantData[j].price;
            break;
          }
        }

        // Se não encontrou nos dados relevantes, usar o último preço conhecido
        if (priceAtPoint === null) {
          if (lastKnownPrice !== null) {
            priceAtPoint = lastKnownPrice;
          } else if (sortedData.length > 0) {
            // Fallback: buscar o último preço em todos os dados
            for (let j = sortedData.length - 1; j >= 0; j--) {
              const dataTime = new Date(sortedData[j].price_changed_at || sortedData[j].collected_at);
              if (dataTime <= point.timestamp) {
                priceAtPoint = sortedData[j].price;
                break;
              }
            }
            // Se ainda não encontrou, usar o primeiro disponível
            if (priceAtPoint === null) {
              priceAtPoint = sortedData[0].price;
            }
          }
        }

        point.price = priceAtPoint;
      }

      // Marcar se é uma mudança real próxima a um ponto fixo
      if (point.isFixed && !point.isActualChange) {
        const hasNearbyChange = relevantData.some(item => {
          const dataTime = new Date(item.price_changed_at || item.collected_at);
          const timeDiff = Math.abs(point.timestamp.getTime() - dataTime.getTime());
          return timeDiff < (intervalMs * 0.15);
        });
        point.isActualChange = hasNearbyChange;
      }
    }

    // Filtrar pontos sem preço válido e garantir que há pelo menos dados dos pontos fixos
    const finalPoints = filteredPoints.filter(point => point.price !== null).map(point => ({
      price: point.price,
      timestamp: point.timestamp,
      price_changed_at: point.timestamp.toISOString(),
      collected_at: point.timestamp.toISOString(),
      isActualChange: point.isActualChange || false
    }));

    // Se não há pontos finais mas temos dados originais, criar pontos fixos com último preço
    if (finalPoints.length === 0 && sortedData.length > 0) {
      const fallbackPrice = sortedData[sortedData.length - 1].price;
      
      for (let i = pointCount - 1; i >= 0; i--) {
        const pointTime = new Date(now.getTime() - (i * intervalMs));
        finalPoints.push({
          price: fallbackPrice,
          timestamp: pointTime,
          price_changed_at: pointTime.toISOString(),
          collected_at: pointTime.toISOString(),
          isActualChange: false
        });
      }
    }

    return finalPoints;
  };

  // Gerar dados da timeline
  const timelineData = generateTimelineData(data, interval);
  
  if (timelineData.length === 0) {
    return (
      <div className={`flex items-center justify-center h-48 text-gray-400 ${className}`}>
        Sem dados suficientes para o intervalo selecionado
      </div>
    );
  }

  const maxPrice = Math.max(...timelineData.map(d => d.price));
  const minPrice = Math.min(...timelineData.map(d => d.price));
  const priceRange = maxPrice - minPrice;

  const minRangePercent = 0.02;
  const actualRange = priceRange < maxPrice * minRangePercent ? maxPrice * minRangePercent : priceRange;

  const padding = actualRange * 0.1;
  const paddedMin = minPrice - padding;
  const paddedMax = maxPrice + padding;
  const paddedRange = paddedMax - paddedMin;

  const getY = (price) => 200 - ((price - paddedMin) / paddedRange) * 180;
  const getX = (index) => (index / (timelineData.length - 1)) * 380 + 10;

  // Função melhorada para criar curvas suaves
  const createPath = () => {
    if (timelineData.length === 1) {
      const x = getX(0);
      const y = getY(timelineData[0].price);
      return `M ${x} ${y} L ${x + 1} ${y}`;
    }

    if (timelineData.length === 2) {
      const x1 = getX(0);
      const y1 = getY(timelineData[0].price);
      const x2 = getX(1);
      const y2 = getY(timelineData[1].price);
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    let path = `M ${getX(0)} ${getY(timelineData[0].price)}`;

    for (let i = 1; i < timelineData.length; i++) {
      const currentX = getX(i);
      const currentY = getY(timelineData[i].price);
      const prevX = getX(i - 1);
      const prevY = getY(timelineData[i - 1].price);

      // Se os preços são iguais, usar linha reta
      if (timelineData[i].price === timelineData[i - 1].price) {
        path += ` L ${currentX} ${currentY}`;
      } else {
        // Para curvas suaves, usar cubic bezier em vez de quadratic
        // Calcular pontos de controle baseados nos pontos vizinhos
        let cp1x = prevX;
        let cp1y = prevY;
        let cp2x = currentX;
        let cp2y = currentY;

        // Se há ponto anterior, ajustar primeiro ponto de controle
        if (i > 1) {
          const prevPrevX = getX(i - 2);
          const prevPrevY = getY(timelineData[i - 2].price);
          
          // Calcular direção da curva baseada no ponto anterior
          const dx1 = prevX - prevPrevX;
          const dy1 = prevY - prevPrevY;
          
          // Suavizar a curva reduzindo a intensidade
          cp1x = prevX + dx1 * 0.3;
          cp1y = prevY + dy1 * 0.3;
        }

        // Se há próximo ponto, ajustar segundo ponto de controle
        if (i < timelineData.length - 1) {
          const nextX = getX(i + 1);
          const nextY = getY(timelineData[i + 1].price);
          
          // Calcular direção da próxima curva
          const dx2 = nextX - currentX;
          const dy2 = nextY - currentY;
          
          // Suavizar a curva reduzindo a intensidade
          cp2x = currentX - dx2 * 0.3;
          cp2y = currentY - dy2 * 0.3;
        }

        // Usar curva cúbica para transições mais suaves
        path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${currentX} ${currentY}`;
      }
    }

    return path;
  };

  const createAreaPath = () => {
    if (timelineData.length === 0) return '';

    let path = `M ${getX(0)} 200 L ${getX(0)} ${getY(timelineData[0].price)}`;

    for (let i = 1; i < timelineData.length; i++) {
      const currentX = getX(i);
      const currentY = getY(timelineData[i].price);
      const prevX = getX(i - 1);
      const prevY = getY(timelineData[i - 1].price);

      if (timelineData[i].price === timelineData[i - 1].price) {
        path += ` L ${currentX} ${currentY}`;
      } else {
        // Usar a mesma lógica de curva suave para a área
        let cp1x = prevX;
        let cp1y = prevY;
        let cp2x = currentX;
        let cp2y = currentY;

        if (i > 1) {
          const prevPrevX = getX(i - 2);
          const prevPrevY = getY(timelineData[i - 2].price);
          const dx1 = prevX - prevPrevX;
          const dy1 = prevY - prevPrevY;
          cp1x = prevX + dx1 * 0.3;
          cp1y = prevY + dy1 * 0.3;
        }

        if (i < timelineData.length - 1) {
          const nextX = getX(i + 1);
          const nextY = getY(timelineData[i + 1].price);
          const dx2 = nextX - currentX;
          const dy2 = nextY - currentY;
          cp2x = currentX - dx2 * 0.3;
          cp2y = currentY - dy2 * 0.3;
        }

        path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${currentX} ${currentY}`;
      }
    }

    path += ` L ${getX(timelineData.length - 1)} 200 Z`;
    return path;
  };

  // Função para formatar data baseada no intervalo
  const formatDateForInterval = (date, interval) => {
    const d = new Date(date);
    switch (interval) {
      case '1h':
        return d.toLocaleString('pt-BR', { 
          day: '2-digit', 
          month: '2-digit', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
      case '6h':
        return d.toLocaleString('pt-BR', { 
          day: '2-digit', 
          month: '2-digit', 
          hour: '2-digit' 
        });
      case '1d':
        return d.toLocaleDateString('pt-BR', { 
          day: '2-digit', 
          month: '2-digit' 
        });
      case '1w':
        return d.toLocaleDateString('pt-BR', { 
          day: '2-digit', 
          month: '2-digit' 
        });
      default:
        return d.toLocaleDateString('pt-BR');
    }
  };

  return (
    <div className={`bg-gray-700 rounded-lg p-4 ${className}`}>
      <div className="mb-2 text-sm text-gray-400">
        Mostrando {timelineData.length} pontos • Intervalo: {interval} • 
        <span className="text-purple-400">●</span> Mudanças reais • 
        <span className="text-gray-500">●</span> Preços mantidos
      </div>
      
      <svg width="100%" height="240" viewBox="0 0 400 240" className="overflow-visible">
        <defs>
          <linearGradient id="priceGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(147, 51, 234)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="rgb(147, 51, 234)" stopOpacity={0.05} />
          </linearGradient>
          <filter id="glow">
            <feMorphology operator="dilate" radius="1" />
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgb(75, 85, 99)" strokeWidth="0.5" opacity="0.3" />
          </pattern>
        </defs>
        <rect width="100%" height="200" fill="url(#grid)" />

        <path d={createAreaPath()} fill="url(#priceGradient)" />

        <path
          d={createPath()}
          fill="none"
          stroke="rgb(147, 51, 234)"
          strokeWidth="3"
          filter="url(#glow)"
          className="drop-shadow-lg"
        />

        {timelineData.map((entry, idx) => {
          const x = getX(idx);
          const y = getY(entry.price);
          return (
            <g key={idx}>
              <circle
                cx={x}
                cy={y}
                r={entry.isActualChange ? "5" : "3"}
                fill={entry.isActualChange ? "rgb(147, 51, 234)" : "rgb(100, 100, 100)"}
                stroke="white"
                strokeWidth="2"
                className="hover:r-6 transition-all duration-200 cursor-pointer"
                style={{ 
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
                  opacity: entry.isActualChange ? 1 : 0.7
                }}
              >
                <title>
                  R$ {entry.price.toFixed(2)} - {formatDateForInterval(entry.timestamp, interval)}
                  {entry.isActualChange ? ' (Mudança real)' : ' (Preço mantido)'}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>

      <div className="grid grid-cols-3 gap-4 mt-4 text-center text-sm">
        <div>
          <p className="text-gray-400">Menor</p>
          <p className="text-lg font-bold text-green-400">
            R$ {minPrice.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-gray-400">Atual</p>
          <p className="text-lg font-bold text-purple-400">
            R$ {timelineData[timelineData.length - 1]?.price.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-gray-400">Maior</p>
          <p className="text-lg font-bold text-red-400">
            R$ {maxPrice.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
};