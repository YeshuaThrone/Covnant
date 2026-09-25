import workRoutes from "./works";
import sweepDirectRoutes from "./sweep-direct";
import sweepAsyncRoutes from "./sweep-async";
import luminateRoutes from "./luminate";

export const covenantRouters = {
  works: workRoutes,
  sweepDirect: sweepDirectRoutes,
  sweepAsync: sweepAsyncRoutes,
  luminate: luminateRoutes,
};

export {
  workRoutes,
  sweepDirectRoutes,
  sweepAsyncRoutes,
  luminateRoutes,
};
