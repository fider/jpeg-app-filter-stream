import { Duplex, DuplexOptions } from "stream";
const padLeft = require("pad-left") as (msg: string, length: number, padWith: string) => void;

// ================================================================================
// For maintenance and development purposes only

export enum eLogLevel {
    LOG_NONE,
    LOG_IMPORTANT_ONLY,
    LOG_ALL_DEBUG
}

(<any>global).pngAppFilterStreamLogLevel = (<any>global).pngAppFilterStreamLogLevel ? (<any>global).pngAppFilterStreamLogLevel : eLogLevel.LOG_NONE;

let debug = (_: any) => {};
let important = (_: any) => {};

switch ((<any>global).pngAppFilterStreamLogLevel as any) {

    case eLogLevel.LOG_IMPORTANT_ONLY: {
        important = console.log;
        break;
    }

    case eLogLevel.LOG_ALL_DEBUG: {
        important = console.log;
        debug = console.log;
        break;
    }
}


// ================================================================================

const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";

// Critical chunks (mandatory to render image)
const IHDR = 1229472850;
const PLTE = 1347179589;
const IDAT = 1229209940;
const IEND = 1229278788;

// Ancillary chunks (not mandatory but they help with better image display)
const cHRM = 1665684045;
const gAMA = 1732332865;
const iCCP = 1766015824;
const sBIT = 1933723988;
const sRGB = 1934772034;
const bKGD = 1649100612;
const hIST = 1749635924;
const tRNS = 1951551059;
const pHYs = 1883789683;
const sPLT = 1934642260;

// Other standard chunks that do not helps to render image
// const tIME = 1950960965;
// const iTXt = 1767135348;
// const tEXt = 1950701684;
// const zTXt = 2052348020;

// Other known special purpose chunk types
// oFFs
// pCAL
// sCAL
// gIFg
// gIFt
// gIFx
// sTER
// dSIG
// eXIf
// fRAcv

const chunkTypeWhitelist = [
    PLTE,
    IDAT,
    // IEND, // special case
    cHRM,
    gAMA,
    iCCP,
    sBIT,
    sRGB,
    bKGD,
    hIST,
    tRNS,
    pHYs,
    sPLT
];


enum eState {
    EXPECT_PNG_SIGNATURE,
    EXPECT_IHDR,

    EXPECT_CHUNK,

    MANDATORY_CHUNK_FOUND, // SOF_n and every marker with known length segment
    PASS_BYTES,

    REDUNDANT_CHUNK_FOUND,
    SKIP_BYTES,

    IEND_FOUND,
    END
};



class PngAppFilter extends Duplex {


    private data: Buffer = Buffer.from("");
    private state: eState = eState.EXPECT_PNG_SIGNATURE;
    private readSize = 16384;
    private skipBytesLeft = 0;
    private passBytesLeft = 0;
    private outputBufferReady = true;
    private lastWriteCallack = this.empty;
    private processingData = false;


    // Maintenance & debug
    private _maxBufferLength = 0;
    private _prevState: eState = -1;


    _write(chunk: Buffer, _enc: string, callback: (err?: Error | null) => void) {
        debug(`_write  ${chunk.length} bytes`);
        this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length);

        this._maxBufferLength =  Math.max(this.data.length, this._maxBufferLength);

        this.lastWriteCallack = callback;

        if (this.outputBufferReady) {
            this.processData();
        }
    }


    _read(size: number) {
        debug(`_read (${size})`);
        // IF size === 0 then just refresh
        if (size) {
            // // debug(`_read size ${size}`)
            if (typeof size !== "number"  ||  size < 0) {
                return this.destroy( new Error(`PngAppFilterStream invalid usage error. Stream that reads from PngAppFilterStream instace called read(size) with invalid size argument. Expected number >= 0. Actual: ${size}`) );
            }
            this.readSize = size;
        }

        this.outputBufferReady = true;
        this.processData();
    }


    private processData() {


        if ( ! this.processingData) {

            this.processingData = true;
            debug(` processData() run`);



            let needMoreData = false;

            while (this.outputBufferReady && ( ! needMoreData)) {

                needMoreData = false;


                // Maintenance & debug
                if (this._prevState !== this.state) {
                    debug(`  new state ${this.state}`);
                    this._prevState = this.state;
                }


                switch (this.state) {


                    case eState.EXPECT_PNG_SIGNATURE: {

                        if (this.data.length < 8) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let pngSignature = this.data.toString("hex", 0, 8);

                        if ( pngSignature !== PNG_SIGNATURE_HEX ) {
                            return this.destroy( new Error(`Stream is not PNG. Expected first bytes to be 0x${PNG_SIGNATURE_HEX.toUpperCase()}. Actual: 0x${pngSignature.toUpperCase()}`) );
                        }

                        this.state = eState.EXPECT_IHDR;
                        this.passBytes(8);

                        break;
                    }


                    case eState.EXPECT_IHDR: {
                        if (this.data.length < 12) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let chunkType = this.getChunkType();
                        let chunkLength = this.getTotalChunkLength();

                        if ( ! this.isIHDRChunkType(chunkType)) {
                            return this.destroy( new Error(`PngAppFilterStream input stream error. Details: expecting IHDR chunk type 0x49484452 but 0x${chunkType.toString(16).toUpperCase()} found instead.`) );
                        }

                        this.state = eState.MANDATORY_CHUNK_FOUND;

                        break;
                    }


                    case eState.EXPECT_CHUNK: {

                        if (this.data.length < 12) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let chunkType = this.getChunkType();
                        debug(`  chunk found: 0x${padLeft(chunkType.toString(16).toUpperCase(), 8, "0")}`);

                        if ( this.isOtherMandatoryChunkType(chunkType) ) {
                            this.state = eState.MANDATORY_CHUNK_FOUND;
                            break;

                        }
                        else if ( this.isIENDChunkType(chunkType) ) {
                            this.state = eState.IEND_FOUND;
                            break;

                        }
                        else if ( this.isValidPngChunkType(chunkType) ) {
                            this.state = eState.REDUNDANT_CHUNK_FOUND;
                            break;
                        }
                        else {
                            return this.destroy( new Error(`PngAppFilterStream input stream data error. Details: invalid chunk type value found 0x${padLeft(chunkType.toString(16).toUpperCase(), 8, "0")}. Expecting that each byte is in range  0x41 to 0x5A  or  0x61 to 0x7A`) );
                        }
                    }


                    case eState.REDUNDANT_CHUNK_FOUND: {

                        if (this.data.length < 4) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        this.skipBytesLeft = this.getTotalChunkLength();
                        this.state = eState.SKIP_BYTES;

                        break;
                    }


                    case eState.SKIP_BYTES: {

                        if ( ! this.data.length) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let numOfBytesToSkip = Math.min(this.skipBytesLeft, this.data.length);
                        this.skipBytes(numOfBytesToSkip);
                        this.skipBytesLeft -= numOfBytesToSkip;

                        if ( ! this.skipBytesLeft) {
                            this.state =  eState.EXPECT_CHUNK;
                            break;
                        }
                        else {
                            // Need to skip more bytes but whole buffer emptied - wait for more data.
                            // Same step (state) will be repeated when more data available.
                            // needMoreData = true;
                        }

                        break;
                    }


                    case eState.MANDATORY_CHUNK_FOUND: {
                        if (this.data.length < 4) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        this.passBytesLeft = this.getTotalChunkLength();

                        this.state = eState.PASS_BYTES;

                        break;
                    }


                    case eState.PASS_BYTES: {

                        if ( ! this.data.length) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        if ( ! this.passBytesLeft) {
                            this.state =  eState.EXPECT_CHUNK;
                            break;
                        }
                        else {
                            // Neet do pass more bytes but whole buffer emptied - need to wait for more data.
                            // Same step (state) will be repeated when more data available.
                            // needMoreData = true;
                        }

                        let numOfBytesToPass = Math.min(this.passBytesLeft, this.data.length, this.readSize);
                        this.passBytesLeft -= numOfBytesToPass;
                        this.passBytes(numOfBytesToPass);

                        break;
                    }


                    case eState.IEND_FOUND: {
                        this.state = eState.END;

                        let lastChunkLength = this.getTotalChunkLength();
                        this.passBytes(lastChunkLength);

                        if (this.data.length) {
                            return this.destroy( new Error(`PngAppFilterStream input stream error. Details: IEND (image en) so expected end of stream without more data. Bytes left: ${this.data.length}`) );
                        }

                        break;
                    }


                    case eState.END: {
                        debug(`    push(null)`);
                        important(`    max buffer size: ${this._maxBufferLength}   (writableHighWaterMark ${this.writableHighWaterMark}  readableHighWaterMark ${this.readableHighWaterMark})`);

                        // Done, do nothing (should be called only once)
                        this.push(null);

                        // I do not need more data - just want to end while loop
                        needMoreData = true;
                        break;
                    }


                    default: {
                        this.destroy( new Error(`PngAppFilterStream internal error. Details: processData() unknown state: ${this.state}`) );
                    }
                }

            }


            this.processingData = false;
            debug(` processData() END   ${this.data.length} bytes left   ${this.outputBufferReady} ${this.isInputBufferReady()} ${needMoreData}`);

            // debug(`writeBufferReady ${this.isWriteBufferReady()}`);
            if (this.isInputBufferReady()) {
                let writeCallback = this.lastWriteCallack;
                this.lastWriteCallack = this.empty;
                writeCallback(); // This may cause this._write() to be called before writeCallback() returns
            }
        }

    }


    private getChunkType() {
        if (this.data.length < 8) {
            throw new Error(`PngAppFilterStream internal error. Details: getChunkType() not enough data (${this.data.length} bytes) to read chunk type.`);
        }

        return this.data.readUInt32BE(4);
    }

    private getTotalChunkLength() {
        if (this.data.length < 4) {
            throw new Error(`PngAppFilterStream internal error. Details: getChunkLength() not enough data (${this.data.length} bytes) to read chunk data length.`);
        }

        // Data length + 4b size + 4b chunk type + 4b CRC
        return this.data.readUInt32BE(0) + 12;
    }


    private isIHDRChunkType(chunkType: number) {
        return  chunkType === IHDR;
    }

    private isIENDChunkType(chunkType: number) {
        return  chunkType === IEND;
    }

    private isOtherMandatoryChunkType(chunkType: number) {
        return chunkTypeWhitelist.includes(chunkType);
    }

    private isValidPngChunkType(chunkType: number) {
        let byte1 = (chunkType >> 0)  & 0xFF;
        let byte2 = (chunkType >> 8)  & 0xFF;
        let byte3 = (chunkType >> 16) & 0xFF;
        let byte4 = (chunkType >> 24) & 0xFF;

        // Ech byte in range a-z or A-Z
        return (
            ( (65 <= byte1 && byte1 <= 90)  ||  ( 97 <= byte1 && byte1 <= 122 ) ) &&
            ( (65 <= byte2 && byte2 <= 90)  ||  ( 97 <= byte2 && byte2 <= 122 ) ) &&
            ( (65 <= byte3 && byte3 <= 90)  ||  ( 97 <= byte3 && byte3 <= 122 ) ) &&
            ( (65 <= byte4 && byte4 <= 90)  ||  ( 97 <= byte4 && byte4 <= 122 ) )
        )
    }


    private isInputBufferReady() {
        // 12 bytes is minimum required by most of state machine cases
        return this.data.length < Math.max(12, this.writableHighWaterMark);
    }


    private passBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call passBytes().
        if (this.data.length < length || length < 1) {
            throw new Error(`PngAppFilterStream internal error. Details: passBytes() not enough data inside internal buffer (${this.data.length} bytes) to pass ${length} bytes.`);
        }

        let dataToPush = this.data.slice(0, length);
        this.data = this.data.slice(length);


        debug(`   pushing...  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)`);
        this.outputBufferReady = this.push(dataToPush);
        debug(`   ....pushed  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)    left ${this.data.slice(0, 12).toString("hex")}...`);
    }

    private skipBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call skipBytes().
        if (this.data.length < length || length < 1) {
            throw new Error(`PngAppFilterStream internal error. Details: skipBytes() not enough data inside internal buffer (${this.data.length} bytes) to skip ${length} bytes.`);
        }

        let skippedData = this.data.slice(0, length);
        this.data = this.data.slice(length);
        debug(`   skip ${skippedData.toString("hex").substr(0, 12)}  (${length} bytes)   (next: ${this.data.toString("hex").substr(0,12)})`);
    }


    private empty() {
        // to nothing
    }
}



export function getPngAppFilterStream(streamOpts?: DuplexOptions) {
    return new PngAppFilter(streamOpts);
}
