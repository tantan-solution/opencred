import {app, PORT} from './app.js';

const bootstrap = () => {
  app.listen(PORT, () => {
    console.log(`app is listening on http://localhost:${PORT}..`);
  });
};

bootstrap();
