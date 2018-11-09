import { Duplex, DuplexOptions } from "stream";
const padLeft = require("pad-left") as (msg: string, length: number, padWith: string) => void;

// ================================================================================
// For maintenance and development purposes only

export enum eLogLevel {
    LOG_NONE,
    LOG_IMPORTANT_ONLY,
    LOG_ALL_DEBUG
}

(<any>global).jpegAppFilterStreamLogLevel = (<any>global).jpegAppFilterStreamLogLevel ? (<any>global).jpegAppFilterStreamLogLevel : eLogLevel.LOG_NONE;

let debug = (_: any) => {};
let important = (_: any) => {};

switch ((<any>global).jpegAppFilterStreamLogLevel as any) {

    case eLogLevel.LOG_IMPORTANT_ONLY: {
        important = console.log;
        break;
    }

    case eLogLevel.LOG_ALL_DEBUG: {
        important = console.log;
        debug = console.log
        break;
    }
}


// ================================================================================

const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const IHDR = 1229472850;


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



class JpegExifFilter extends Duplex {


    private data: Buffer = Buffer.from("");
    private state: eState = eState.EXPECT_PNG_SIGNATURE;
    private readSize = 16384;
    private skipBytesLeft = 0;
    private passBytesLeft = 0;
    private outputBufferReady = true;
    private lastWriteCallack = this.empty;
    private processingData = false;

    // Error info only
    private bytesProcessed = 0;


    // Maintenance & debug
    private _maxBufferLength = 0;
    private _prevState: eState = -1;


    _write(chunk: Buffer, _enc: string, callback: (err?: Error | null) => void) {
        debug(`_write  ${chunk.length} bytes`);
        this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length);

        this._maxBufferLength =  Math.max(this.data.length, this._maxBufferLength);

        this.processData();

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
                this.destroy( new Error(`PngAppFilterStream invalid usage error. Stream that reads from PngAppFilterStream instace called read(size) with invalid size argument. Expected number >= 0. Actual: ${size}`) );
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
                            this.destroy( new Error(`Stream is not PNG. Expected first bytes to be 0x${PNG_SIGNATURE_HEX.toUpperCase()}. Actual: 0x${pngSignature.toUpperCase()}`) );
                        }

                        this.state = eState.EXPECT_CHUNK;
                        this.passBytes(4);

                        break;
                    }


                    case eState.EXPECT_IHDR: {
                        if (this.data.length < 8) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let chunkType = this.getChunkType();
                        let chunkLength = this.getTotalChunkLength();

                        if (chunkType !== IHDR) {
                            this.destroy( new Error(`PngAppFilterStream input stream error. Details: expecting IHDR chunk type 0x49484452 but 0x${chunkType.toString(16).toUpperCase()} found instead.`) );
                        }

                        this.state = eState.EXPECT_CHUNK;

                        // 4b size + 4b chunk type + 4b crc
                        this.passBytes(chunkLength);
                    }


                    case eState.EXPECT_CHUNK: {

                        if (this.data.length < 8) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        let chunkType = this.getChunkType();

                        if ( this.isMandatoryChunkType(chunkType) ) {
                            this.state = eState.MANDATORY_CHUNK_FOUND;
                            break;

                        }
                        else if ( this.isValidChunkTypeValue(chunkType) ) {
                            this.state = eState.REDUNDANT_CHUNK_FOUND;
                            break;

                        }
                        else if ( this.isIENDChunkType(chunkType) ) {
                            this.state = eState.IEND_FOUND;
                            break;

                        }
                        else {
                            this.destroy( new Error(`PngAppFilterStream input stream data error. Details: invalid chunk type value found 0x${padLeft(chunkType.toString(16).toUpperCase(), 8, "0")}. Expecting that each byte is in range  0x41 to 0x5A  or  0x61 to 0x7A`) );
                            break;
                        }
                    }


                    case eState.REDUNDANT_CHUNK_FOUND: {

                        if (this.data.length < 4) {
                            needMoreData = true;
                            break; // wait for more data
                        }

                        this.skipBytesLeft = this.getLengthOfWholeSegment();

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

                        this.passBytesLeft = this.getLengthOfWholeSegment();

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


                    case eState.SOS_MARKER_FOUND: {

                        if (this.data.length < 5) {
                            needMoreData = true;
                            break;
                        }

                        this.state = eState.PASS_BYTES_UNTIL_NEXT_NON_SOS_MARKER;
                        this.passBytes(5);


                        break;
                    }


                    case eState.PASS_BYTES_UNTIL_NEXT_NON_SOS_MARKER: {
                        if (this.data.length < 2) {
                            needMoreData = true;
                            break;
                        }

                        let index;
                        let offset = 0;
                        let flushData = true;

                        while( (index = this.data.indexOf("ff", offset, "hex")) >= 0) {

                            // Need 2 bytes to read whole marker
                            if (index + 2 > this.data.length ) {
                                // Found begin of marker (0xFF) but it is end of data buffer so I am unable to check what marker it is
                                // Need to wait for at least one more byte.
                                flushData = false;

                                // Pass all but last byte (keep last 0xFF).
                                // Last 0xFF will be necessary when more data will arrive to properly read marker.
                                this.passAllBytesExceptLast(1);

                                needMoreData = true;
                                break;
                            }
                            else if ( this.isNextMarkerThatEndsSosData( this.getMarker(index) ) ) {
                                // Found end of SOS segment
                                flushData = false;


                                if (index) {
                                    this.passBytes(index);
                                }

                                this.state = eState.EXPECT_CHUNK;
                                break;
                            }
                            else {
                                // Found 0xFF but it is not known marker - continue to search.
                                // If nothing found in whole data buffer then flush it all.
                                flushData = true;
                            }


                            // Nothing found, increase search offset and continue to search
                            offset = index + 2; // 2 bytes after
                        }

                        // Nothig found - pass all and wait for more data
                        if (flushData && this.data.length) {
                            this.passBytes( this.data.length );
                        }
                        needMoreData = true;

                        break;
                    }


                    case eState.IEND_FOUND: {
                        this.state = eState.END;
                        this.passBytes(2); // PASS EOI

                        if (this.data.length) {
                            this.destroy( new Error(`JpegExifFilter input stream error. Details: EOI (end of image) so expected end of stream without more data. Bytes left: ${this.data.length}`) );
                            break;
                        }

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
                        this.destroy( new Error(`JpegExifFilter internal error. Details: processData() unknown state: ${this.state}`) );
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
            this.destroy( new Error(`PngAppFilterStream internal error. Details: getChunkType() not enough data (${this.data.length} bytes) to read chunk type.`) );
        }

        return this.data.readUInt32BE(4);
    }


    private getTotalChunkLength() {
        if (this.data.length < 4) {
            this.destroy( new Error(`PngAppFilterStream internal error. Details: getChunkLength() not enough data (${this.data.length} bytes) to read chunk data length.`) );
        }

        // Data length + 4b size + 4b chunk type + 4b CRC
        return this.data.readUInt32BE(0) + 12;
    }




    private isInputBufferReady() {
        return this.data.length < this.writableHighWaterMark;
    }


    private isNextMarkerThatEndsSosData(marker: number) {
        return (
            this.isMandatoryMarkerWihtKnownLength(marker)
             ||
            this.isAppMarker(marker)
             ||
            this.isJpgMarker(marker)
             ||
            this.isComMarker(marker)
             ||
            this.isEoiMarker(marker)
             ||
            this.isSosMarker(marker) // In theory should not occure just after SOS
        );

        /*
            Other markers, not included above:
            0xFF00:  Special value used to encode 0xFF inside SOS data segment.
            0xFF01:  TEM (private use in arithmetic coding. Standalone marker - not followed by 2 bytes of length. IMO. it can be part of SOS data segment)
            0xFF02 - 0xFFBF:  reserved (so IMO. they should not appear as part of encoded data inside SOS segment)
            0xFFD0 - 0xFFD7:  RST (standalone marker used inside encoded SOS data segment)
        */
    }

    private isSoiMarker(marker: number) {
        return marker !== 0xFFD8; // SOI - start of image (start of jpeg stream)
    }

    private isMandatoryMarkerWihtKnownLength(marker: number) {
        return (
            (0xFFC0 <= marker  &&  marker <= 0xFFCF) // SOF_0 - SOF_15  (SOF_4=DHT, SOF_12=DAC)
             ||
            (0xFFDB <= marker  &&  marker <= 0xFFDF) // DQT, DNL, DRI, DHP, EXP
        );
    }

    private isSosMarker(marker: number) {
        return  marker === 0xFFDA; // SOS - start of scan
    }

    private isAppMarker(marker: number) {
        return  (0xFFE0 <= marker  &&  marker <= 0xFFEF); // Reserved for application segments
    }

    private isJpgMarker(marker: number) {
        return  (0xFFF0 <= marker  &&  marker <= 0xFFFD); // Reserved for JPEG extension
    }

    private isComMarker(marker: number) {
        return  marker === 0xFFFE; // COM - comment
    }

    private isEoiMarker(marker: number) {
        return marker === 0xFFD9; // EOI - end of image (end of jpeg stream)
    }


    private getLengthOfWholeSegment(index = 0) {
        // Expecting 0xMMMMSSSS
        // M - marker
        // S - data length (uint16 big endian)

        // IF  long enough to read segment length
        if ((this.data.length - index < 4)) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: getMarkerAndDataLength() not enough data (${this.data.length} bytes) to read marker length at position ${index}.`) );
        }

        // IF  is marker
        if (this.data.readUInt8(0) !== 0xFF) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: getMarkerAndDataLength() data is not marker: 0x${this.data.slice(0, 2).toString("hex")}`) );
        }


        // 2 bytes of marker + segment length (2 bytes that contains length + data bytes)
        return ( 2 + this.data.readUInt16BE(2) );
    }


    private passBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call passBytes().
        if (this.data.length < length || length < 1) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: passBytes() not enough data inside internal buffer (${this.data.length} bytes) to pass ${length} bytes.`) );
        }

        let dataToPush = this.data.slice(0, length);
        this.data = this.data.slice(length);

        this.bytesProcessed += length;

        debug(`   pushing...  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)`);
        this.outputBufferReady = this.push(dataToPush);
        debug(`   ....pushed  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)    left ${this.data.slice(0, 12).toString("hex")}...`);
    }


    private passAllBytesExceptLast(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call passAllBytesExceptLast().
        if (this.data.length < length || length < 0) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: passAllBytesExceptLast() not enough data inside internal buffer (${this.data.length} bytes) to pass ${length} bytes.`) );
        }

        let numOfBytesToPass = this.data.length - length;
        if (numOfBytesToPass === 0) {
            return;
        }

        let dataToPush = this.data.slice(0, numOfBytesToPass);
        this.data = this.data.slice(numOfBytesToPass);

        // // debug(`# Pass ${dataToPush.toString("hex")}  (next: ${this.data.toString("hex").substr(0,10)})`);
        this.bytesProcessed += length;

        debug(`   pushing...  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)`);
        this.outputBufferReady = this.push(dataToPush);
        debug(`   ....pushed  ${dataToPush.toString("hex").substr(0,12)}... (${dataToPush.length} bytes)`);
    }


    private skipBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call skipBytes().
        if (this.data.length < length || length < 1) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: skipBytes() not enough data inside internal buffer (${this.data.length} bytes) to skip ${length} bytes.`) );
        }

        this.bytesProcessed += length;
        let skippedData = this.data.slice(0, length);
        this.data = this.data.slice(length);
        debug(`   skip ${skippedData.toString("hex").substr(0, 12)}  (${length} bytes)   (next: ${this.data.toString("hex").substr(0,12)})`);
    }


    private getMarker(index = 0) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call getMarker().
        if (this.data.length - index < 2) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: getMarker() not enough data inside internal buffer (${this.data.length} bytes) to read marker at position ${index}.`) );
        }

        return this.data.readUInt16BE(index);
    }


    private empty() {
        // to nothing
    }
}



export function getJpegExifFilter(opts?: DuplexOptions) {
    return new JpegExifFilter(opts);
}
