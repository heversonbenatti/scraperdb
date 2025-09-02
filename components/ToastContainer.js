import { useEffect, useState } from 'react';

const Toast = ({ toast, onRemove }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Entrada animada
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => onRemove(toast.id), 300);
  };

  const getToastIcon = () => {
    switch (toast.type) {
      case 'success':
        return '✅';
      case 'error':
        return '❌';
      case 'warning':
        return '⚠️';
      case 'info':
      default:
        return '💬';
    }
  };

  const getToastColors = () => {
    switch (toast.type) {
      case 'success':
        return 'bg-green-600 border-green-500';
      case 'error':
        return 'bg-red-600 border-red-500';
      case 'warning':
        return 'bg-yellow-600 border-yellow-500';
      case 'info':
      default:
        return 'bg-blue-600 border-blue-500';
    }
  };

  return (
    <>
      <style jsx>{`
        @keyframes toast-shrink {
          from {
            width: 100%;
          }
          to {
            width: 0%;
          }
        }
        .progress-bar {
          animation: toast-shrink ${toast.duration || 5000}ms linear forwards;
        }
      `}</style>
      
      <div
        className={`
          transform transition-all duration-300 ease-in-out mb-2
          ${
            isVisible && !isExiting
              ? 'translate-x-0 opacity-100'
              : 'translate-x-full opacity-0'
          }
          max-w-sm w-full ${getToastColors()} border-l-4 rounded-lg shadow-lg
          text-white
        `}
      >
        <div className="flex items-center p-4">
          <span className="text-lg mr-3 flex-shrink-0">
            {getToastIcon()}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium break-words pr-2">
              {toast.message}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="ml-2 flex-shrink-0 text-white hover:text-gray-200 transition-colors"
            title="Fechar notificação"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path 
                fillRule="evenodd" 
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" 
                clipRule="evenodd" 
              />
            </svg>
          </button>
        </div>
        
        {/* Barra de progresso para mostrar tempo restante */}
        {toast.duration && toast.duration > 0 && (
          <div className="h-1 bg-black bg-opacity-20 rounded-b-lg overflow-hidden">
            <div className="progress-bar h-full bg-white bg-opacity-30 transition-all ease-linear" />
          </div>
        )}
      </div>
    </>
  );
};

const ToastContainer = ({ toasts, onRemoveToast }) => {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] space-y-2">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          onRemove={onRemoveToast}
        />
      ))}
    </div>
  );
};

export { Toast, ToastContainer };
export default ToastContainer;
