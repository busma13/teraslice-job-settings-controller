import { Logger } from "@terascope/types";

export default class PIDController {
    logger: Logger;
    private outputMin: number;
    private outputMax: number;
    private kp: number;
    private ki: number;
    private kd: number;

    private integral = 0;
    private lastError = 0;

    /**
     * A simple Proportional–integral–derivative controller implementation
     * https://en.wikipedia.org/wiki/Proportional%E2%80%93integral%E2%80%93derivative_controller
     * 
     * @param {number} min Minimum allowable output
     * @param {number} max Maximum allowable output
     * @param {number} kp proportional constant
     * @param {number} ki integral constant
     * @param {number} kd derivative constant
    */
    constructor(logger: Logger, min: number, max: number, kp: number, ki: number, kd: number) {
        this.logger = logger;
        this.kp = kp;
        this.ki = ki;
        this.kd = kd;
        this.outputMin = min;
        this.outputMax = max;
    }

    /**
     * 
     * @param error percentage difference between the desired setpoint and the measured process variable.
     * In this case the setpoint is the desired number of bytes for a window of time (TARGET_BYTES_PER_WINDOW).
     * The process variable is the increase in the size of an elasticsearch index since the last check (bytesSinceLastRead)
     * The error percentage is then calculated as (process variable - setpoint) / process variable.
     * @returns 
     */
    update(error: number): number {
        const derivative = error - this.lastError;
        const tempIntegral = this.integral + error;

        const unclampedOutput = this.kp * error + this.ki * tempIntegral + this.kd * derivative;

        // clamp the output
        const output = Math.max(this.outputMin, Math.min(this.outputMax, unclampedOutput));

        // check if output is saturated and error is not improving
        const outputSaturatedHigh = output === this.outputMax && error > 0;
        const outputSaturatedLow = output === this.outputMin && error < 0;

        // only update integral if output is not saturated
        if (!outputSaturatedHigh && !outputSaturatedLow) {
            this.integral = tempIntegral;
        }
        
        this.logger.debug({
            previousError: this.lastError,
            derivative,
            tempIntegral,
            unclampedOutput,
            output,
            outputSaturatedHigh,
            outputSaturatedLow,
            integral: this.integral
        })

        this.lastError = error;

        return output;
    }
}
