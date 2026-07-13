import { NextFunction, Response } from "express";
import { AuthenticatedRequest } from "./authTypes";

/**
 * ============================================================
 * LOGIN TEMPORARIAMENTE DESABILITADO
 * ============================================================
 *
 * Todas as requisições serão tratadas como se fossem de um
 * usuário administrador autenticado.
 *
 * Para reativar o login, basta restaurar este arquivo.
 * ============================================================
 */

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  req.user = {
    id: "dev-user",
    username: "Administrador",
    role: "admin",
  } as any;

  next();
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  next();
}
