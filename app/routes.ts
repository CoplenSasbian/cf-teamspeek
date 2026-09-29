import type { RouteConfig } from '@react-router/dev/routes';
import { index, route } from '@react-router/dev/routes';

export default [
  index('routes/lobby.tsx'),
  route('room/:id', 'routes/room.tsx'),
  route('dev', 'routes/dev.tsx'),
] satisfies RouteConfig;
