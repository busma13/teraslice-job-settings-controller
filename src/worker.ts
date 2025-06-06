import { Terafoundation as TF } from '@terascope/types';
import PIDController from './pid-controller.js';
import { Client, Config } from './interfaces.js';

import * as fs from 'node:fs';

export async function worker(context: TF.Context<Config>) {
    const events = context.apis.foundation.getSystemEvents();
    const { logger } = context;
    const config = context.sysconfig.terasliceJobSettingsController;
    const TARGET_RATE_BYTES_PER_SEC = config.target_rate * 1024 * 1024;
    const TARGET_BYTES_PER_WINDOW = TARGET_RATE_BYTES_PER_SEC * (config.window_ms / 1000);
    const PERCENT_MIN = 0;
    const PERCENT_MAX = 1;

    logger.info('Teraslice Job Settings Controller Config:\n', config);
    logger.debug('TARGET_RATE_BYTES_PER_SEC: ', TARGET_RATE_BYTES_PER_SEC);
    logger.info('TARGET_BYTES_PER_WINDOW: ', TARGET_BYTES_PER_WINDOW);
    
    let decimalPercentage = config.initial_percent_kept / 100;
    let indexBytes = 0;
    let retrievalErrorCount = 0;
    let retrievalFailed: boolean;
    let intervals = 0;
    let deltaBytes: number;

    // PID controller setup
    const ADJUSTMENT_MIN = -0.25;
    const ADJUSTMENT_MAX = .25;
    const pid = new PIDController(logger, ADJUSTMENT_MIN, ADJUSTMENT_MAX, ...config.pid_constants);

    // Elasticsearch client setup
    let sampleIndex = _buildSampleIndexString();
    let esClientSample: Client;
    let esClientStore: Client;
    esClientSample = (await context.apis.foundation.createClient({ type: 'elasticsearch-next', endpoint: config.connections.sample.connector })).client;
    esClientStore = (await context.apis.foundation.createClient({ type: 'elasticsearch-next', endpoint: config.connections.store.connector })).client;
    
    // Logging setup
    let logStream: fs.WriteStream;
    _setupLogs();
    
    // Set initial values
    indexBytes = await _getIndexSize();
    _updateStoreDocument(config.initial_percent_kept)

    /**
     * Every window_ms, get the size of the sample index, calculate
     * the change in size, then calculate a new percentage
     */
    const updatePercentKeptInterval: NodeJS.Timeout = setInterval(async () => {
        intervals++;
        sampleIndex = _updateSampleIndex();
        logger.debug('Sample Index: ', sampleIndex);

        logger.debug('Index bytes previous read: ', indexBytes);
        const newIndexBytes = await _getIndexSize();
        logger.debug('Index bytes this read: ', newIndexBytes);

        const bytesSinceLastRead = newIndexBytes - indexBytes;
        logger.debug('Difference in bytes since last read: ', bytesSinceLastRead);
        
        indexBytes = newIndexBytes;

        // skip percentage calculation if index size could not be retrieved
        if (retrievalFailed) {
            // count successive failures so we can properly calculate
            // the error once retrieval is successful
            retrievalErrorCount++;
            logger.info('Unable to retrieve index size, skipping percentage update this window.');
            return;
        }
        decimalPercentage = _calculatePercentage(bytesSinceLastRead, decimalPercentage);
        retrievalErrorCount = 0;
    }, config.window_ms);

    /**
     * Get the size of the sample index, or return the previous
     * index size if the request fails.
     * @returns { Promise<number> } Size in bytes of the sample index
     */
    async function _getIndexSize(): Promise<number> {
        retrievalFailed = false;
        try {
            const indexInfo = await esClientSample.cat.indices({
                index: sampleIndex,
                bytes: 'b',
                format: 'json'
            });
            let size: number;
            const sizeStr: string | undefined = indexInfo[0]['store.size'];
            if (!sizeStr) {
                throw new Error('store.size is undefined');
            }
            size = Number(sizeStr)
            return size;
        } catch (err) {
            retrievalFailed = true;
            logger.warn(`Error retrieving index size: ${err}`);
            return indexBytes;
        }
    }

    /**
     * Calculate the percentage of records to keep during the next window 
     * @param { number } bytesSinceLastRead number of bytes added to the index since the
     *                                      last successful read 
     * @param { number } previousPercentage the percentage calculated from the previous
     *                                      window or the initial percentage
     * @returns { number } Percentage of records to keep
     */
    function _calculatePercentage(bytesSinceLastRead: number, previousPercentage: number) {
        const totalTimeSecs = intervals * config.window_ms / 1000;
        const indexMB = indexBytes / (1024 * 1024);
        const avgRateMBPerSec = indexMB / totalTimeSecs

        const windowsSinceLastUpdate = retrievalErrorCount + 1
        const averageBytesSinceLastUpdate = bytesSinceLastRead / windowsSinceLastUpdate;
        setDeltaBytes(averageBytesSinceLastUpdate);
        logger.debug('deltaBytes: ', deltaBytes);

        const errorBytesDelta = deltaBytes - TARGET_BYTES_PER_WINDOW; 
        const errorPctDelta = errorBytesDelta / TARGET_BYTES_PER_WINDOW;
        const adjustment = pid.update(errorPctDelta);
        const newPercentage = previousPercentage - adjustment;
        logData(previousPercentage, errorPctDelta, bytesSinceLastRead, deltaBytes, avgRateMBPerSec);

        // clamp percentKept between MIN and MAX
        const clampedPercentage = Math.max(PERCENT_MIN, Math.min(PERCENT_MAX, newPercentage));

        logger.debug({
            totalTimeSecs,
            avgRateMBPerSec,
            windowsSinceLastUpdate,
            errorBytesDelta,
            errorPctDelta,
            adjustment,
            newPercentage,
            clampedPercentage
        })

        const percent = clampedPercentage * 100;

        _updateStoreDocument(percent);

        logger.info(`Target: ${Math.round(TARGET_BYTES_PER_WINDOW)} bytes, Actual: ${bytesSinceLastRead} bytes, Delta: ${deltaBytes} bytes, Sample Rate: ${percent.toFixed(3)} percent`);
        return clampedPercentage;
    }

    function _setupLogs() {
        // fixme don't overwrite logs
        const logFilePath = '/app/logs/sample-log.csv';

        try {
            fs.writeFileSync(logFilePath, '')
        } catch (err) {
            logger.error('writeFileSync err: ', err);
        }
        try {
            logStream = fs.createWriteStream(logFilePath);
            logStream.write('timestamp,percentKept,errorPctDelta,bytesThisWindow,deltaBytes,avgRateMBPerSec\n');
        } catch (err) {
            logger.error(`Failed to create log stream. Err: ${err}`);
        }
    }

    function logData(percentage: number, errorPctDelta: number, bytes: number, deltaBytes: number, avgRate: number) {
        if (logStream) {
            const timestamp = new Date().toISOString();
            logStream.write(`${timestamp},${percentage.toFixed(4)},${errorPctDelta.toFixed(4)},${bytes},${deltaBytes.toFixed(4)},${avgRate.toFixed(4)}\n`);
        }
    }

    function _resetIndexBytes() {
        indexBytes = 0;
    }

    /**
     * @param { Date } date The Date object to be parsed
     * @returns { string[] } Array containing the year, month, and day
     */
    function _parseDate(date: Date): string[] {
        return date.toISOString()
            .slice(0, 11)
            .split(/[-T\s]/);
    }

    /**
     * Build the sample index string from the dailyIndexPrefix, delimiter, and system date
     * @returns { string } Current index to sample
     */
    function _buildSampleIndexString(): string {
        const { dailyIndexPrefix: pre, date_delimiter: del } = config.connections.sample;
        const [year, month, day] = _parseDate(new Date());
        return `${pre}-${year}${del}${month}${del}${day}`;
    }

    /**
     * Calculate the sample index and reset indexBytes to
     * zero if the sample index has changed
     * @returns { string } sample index string
     */
    function _updateSampleIndex(): string {
        const newIndex = _buildSampleIndexString();
        if (newIndex !== sampleIndex) {
            _resetIndexBytes();
        }
        return newIndex;
    }

    /**
     * Updates the document on the store connection with a new percent.
     * @param percent New calculated percent to store
     */
    function _updateStoreDocument(percent: number) {
        const { document_id: id, index } = config.connections.store;
        try{
            esClientStore.update({
                id,
                index,
                body: {
                    doc: {
                        percent,
                        index: sampleIndex,
                        updated: Date.now()
                    },
                    doc_as_upsert: true
                }
            });
        } catch (err) {
            logger.warn(`Error updating document with id ${id}: ${err}`);
        }
    }

    /**
     * Calculates the exponential moving average change in index size
     * @param newDelta change in index size since last read
     * @param alpha Smoothing factor between 0 and 1. Controls how fast the average reacts.
     */
    function setDeltaBytes(newDelta: number, alpha = 0.2) {
        if (!deltaBytes) {
            deltaBytes = newDelta;
        } else {
            deltaBytes = alpha * newDelta + (1 - alpha) * deltaBytes;
        }
    }

    /**
     * Listens for a terafoundation shutdown event.
     * Clears interval and exits.
     */
    events.once('terafoundation:shutdown', () => {
        logger.debug('received shutdown notice from terafoundation');
        clearInterval(updatePercentKeptInterval);
        process.exit(0);
    });
}