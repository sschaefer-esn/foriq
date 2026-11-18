import common from "./common.js";
import layout from "./layout.js";
import auth from "./auth.js";
import dashboard from "./dashboard.js";
import data from "./data.js";
import floorPlan from "./floorPlan.js";
import charts from "./charts.js";
import devices from "./devices.js";
import deviceDetail from "./deviceDetail.js";
import notifications from "./notifications.js";
import exportPage from "./export.js";
import settings from "./settings.js";

const messages = {
  ...common,
  ...layout,
  ...auth,
  ...dashboard,
  ...data,
  ...floorPlan,
  ...charts,
  ...devices,
  ...deviceDetail,
  ...notifications,
  ...exportPage,
  ...settings,
};

export default messages;
