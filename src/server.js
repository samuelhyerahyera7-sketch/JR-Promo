'use strict';

const { start } = require('./bootstrap');

const PORT = Number(process.env.PORT) || 3000;

start()
  .then(({ app }) => app.listen(PORT, () => console.log(`JR Promotions stock system running on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
