import {
  indexHtml,
  adminHtml,
  frameforgeCss,
  apiJs,
  userJs,
  adminJs,
} from "./static_assets.generated";

export interface StaticAsset {
  data: string;
  contentType: string;
}

export const STATIC_ASSETS: Record<string, StaticAsset> = {
  "/": { data: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { data: indexHtml, contentType: "text/html; charset=utf-8" },
  "/admin.html": { data: adminHtml, contentType: "text/html; charset=utf-8" },
  "/css/frameforge.css": { data: frameforgeCss, contentType: "text/css; charset=utf-8" },
  "/js/api.js": { data: apiJs, contentType: "application/javascript; charset=utf-8" },
  "/js/user.js": { data: userJs, contentType: "application/javascript; charset=utf-8" },
  "/js/admin.js": { data: adminJs, contentType: "application/javascript; charset=utf-8" },
};
