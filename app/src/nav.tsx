import { createContext, useContext } from "react";

export type ViewName = "home" | "search" | "detail" | "compare" | "favorites" | "onboarding" | "partners" | "exchange" | "account" | "submit" | "admin";
export type Go = (view: ViewName, params?: { id?: string; q?: string }) => void;

export const NavContext = createContext<Go>(() => {});
export const useNav = () => useContext(NavContext);
