import fs from "fs";

export function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}