import { query } from './db.js';

(async () => {
  try {
    const result = await query('SELECT 1 AS test', []);
    console.log('Conexão ao banco de dados bem-sucedida. Resultado:', result.rows);
    process.exit(0);
  } catch (err) {
    console.error('Erro ao conectar ao banco de dados:', err);
    process.exit(1);
  }
})();
