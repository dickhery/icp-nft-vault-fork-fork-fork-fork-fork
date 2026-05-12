import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import type { Principal } from "@icp-sdk/core/principal";
import { useCallback } from "react";

export interface AuthIdentity {
  getPrincipal: () => Principal;
}

export interface UseAuthReturn {
  identity: AuthIdentity | null;
  principal: Principal | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  principalText: string | null;
}

export function useAuth(): UseAuthReturn {
  const {
    identity: internetIdentity,
    isAuthenticated,
    isLoggingIn,
    login,
    clear,
  } = useInternetIdentity();

  const identity =
    isAuthenticated && internetIdentity
      ? (internetIdentity as AuthIdentity)
      : null;
  const principal = identity ? identity.getPrincipal() : null;
  const principalText = principal ? principal.toString() : null;

  const logout = useCallback(() => {
    clear();
  }, [clear]);

  return {
    identity,
    principal,
    isAuthenticated,
    isLoading: isLoggingIn,
    login,
    logout,
    principalText,
  };
}
