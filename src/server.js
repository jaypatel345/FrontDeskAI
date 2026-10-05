import { app } from './app.js';
import { config } from './config.js';
import { schedulingMode } from './services/scheduling.js';
import { crmMode } from './services/crm.js';
import { smsMode } from './services/sms.js';
import { ragMode } from './services/rag.js';

app.listen(config.port, () => {
  console.log(`AI receptionist backend listening on :${config.port}`);
  console.log(`  scheduling: ${schedulingMode}`);
  console.log(`  crm:        ${crmMode}`);
  console.log(`  sms:        ${smsMode}`);
  console.log(`  rag:        ${ragMode}`);
  console.log(`  dashboard:  http://localhost:${config.port}/dashboard`);

  // Each of these fails closed in production, so a missing value means that route is locked, not open.
  const warn = (name, what) =>
    console.warn(
      config.isProduction
        ? `  WARNING: ${name} is not set - ${what} will reject every request.`
        : `  WARNING: ${name} is not set - ${what} is open (dev only).`
    );
  if (!config.functionsSecret) warn('FUNCTIONS_SECRET', '/functions/*');
  if (!config.dashboard.password) warn('DASHBOARD_PASSWORD', '/dashboard');
  if (!config.retell.apiKey) warn('RETELL_API_KEY', 'the Retell webhook signature check');
});
