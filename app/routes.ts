import type { RouteConfig } from '@react-router/dev/routes';
import { index, layout, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('admin/login', 'routes/admin-login.tsx'),
  layout('routes/app-shell.tsx', [
    index('routes/welcome.tsx'),
    route('room/:id', 'routes/room.tsx'),
  ]),
  route('dev', 'routes/dev.tsx'),
] satisfies RouteConfig;
