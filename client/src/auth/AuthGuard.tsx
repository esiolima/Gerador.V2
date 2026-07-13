import { ReactNode } from "react";

export default function AuthGuard({ children }: { children: ReactNode }) {
  // LOGIN TEMPORARIAMENTE DESABILITADO
  return <>{children}</>;
}
