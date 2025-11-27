"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dynamicCommand = dynamicCommand;
function dynamicCommand(command) {
    return `marimo.dynamic.${command}`;
}
