import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const Ctx = createContext(() => {});

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, { bad = false, ms = 3000 } = {}) => setToast({ message, bad, id: Date.now(), ms }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`} role="status">{toast.message}</div>}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
