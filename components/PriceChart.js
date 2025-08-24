export const PriceChart = ({ data, className = "" }) => {
  if (!data || data.length === 0) {
    return (
      <div className={`flex items-center justify-center h-48 text-gray-400 ${className}`}>
        Sem dados de histórico disponíveis
      </div>
    );
  }

  const maxPrice = Math.max(...data.map(d => d.price));
  const minPrice = Math.min(...data.map(d => d.price));
  const priceRange = maxPrice - minPrice;

  const minRangePercent = 0.02;
  const actualRange = priceRange < maxPrice * minRangePercent ? maxPrice * minRangePercent : priceRange;

  const padding = actualRange * 0.1;
  const paddedMin = minPrice - padding;
  const paddedMax = maxPrice + padding;
  const paddedRange = paddedMax - paddedMin;

  const getY = (price) => 200 - ((price - paddedMin) / paddedRange) * 180;
  const getX = (index) => (index / (data.length - 1)) * 380 + 10;

  const createPath = () => {
    if (data.length === 1) {
      const x = getX(0);
      const y = getY(data[0].price);
      return `M ${x} ${y} L ${x + 1} ${y}`;
    }

    let path = `M ${getX(0)} ${getY(data[0].price)}`;

    for (let i = 1; i < data.length; i++) {
      const x = getX(i);
      const y = getY(data[i].price);
      const prevX = getX(i - 1);
      const prevY = getY(data[i - 1].price);

      const cpx = prevX + (x - prevX) / 2;
      path += ` Q ${cpx} ${prevY} ${x} ${y}`;
    }

    return path;
  };

  const createAreaPath = () => {
    if (data.length === 0) return '';

    let path = `M ${getX(0)} 200 L ${getX(0)} ${getY(data[0].price)}`;

    for (let i = 1; i < data.length; i++) {
      const x = getX(i);
      const y = getY(data[i].price);
      const prevX = getX(i - 1);
      const prevY = getY(data[i - 1].price);

      const cpx = prevX + (x - prevX) / 2;
      path += ` Q ${cpx} ${prevY} ${x} ${y}`;
    }

    path += ` L ${getX(data.length - 1)} 200 Z`;
    return path;
  };

  return (
    <div className={`bg-gray-700 rounded-lg p-4 ${className}`}>
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

        {data.map((entry, idx) => {
          const x = getX(idx);
          const y = getY(entry.price);
          return (
            <g key={idx}>
              <circle
                cx={x}
                cy={y}
                r="4"
                fill="rgb(147, 51, 234)"
                stroke="white"
                strokeWidth="2"
                className="hover:r-6 transition-all duration-200 cursor-pointer"
                style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' }}
              >
                <title>
                  R$ {entry.price.toFixed(2)} - {new Date(entry.price_changed_at || entry.collected_at).toLocaleDateString('pt-BR')}
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
            R$ {data[data.length - 1]?.price.toFixed(2)}
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