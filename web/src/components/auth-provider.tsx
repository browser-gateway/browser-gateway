"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { checkAuth, login as apiLogin, logout as apiLogout, AuthError } from "@/lib/api";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  authRequired: boolean;
  login: (token: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  authenticated: false,
  authRequired: false,
  login: async () => false,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    checkAuth()
      .then((data) => {
        setAuthenticated(data.authenticated);
        setAuthRequired(data.authRequired);
      })
      .catch(() => {
        setAuthRequired(false);
        setAuthenticated(true);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (token: string) => {
    const ok = await apiLogin(token);
    if (ok) setAuthenticated(true);
    return ok;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, authenticated, authRequired, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
