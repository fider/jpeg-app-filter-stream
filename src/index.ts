import { Duplex, DuplexOptions } from "stream";



enum eState {
    EXPECT_SOI,
    EXPECT_MARKER,

    MANDATORY_MARKER_FOUND, // SOF_n and every marker with known length segment
    PASS_BYTES,

    REDUNDANT_MARKER_FOUND,
    SKIP_BYTES,

    SOS_MARKER_FOUND,
    PASS_BYTES_UNTIL_NEXT_NON_SOS_MARKER,

    EOI_FOUND,
    END
};


let maxLen = 0;
let maxRecCall = 0;
class JpegExifFilter extends Duplex {


    private data: Buffer = Buffer.from("");
    private state: eState = eState.EXPECT_SOI;
    private readSize = 16384;
    private skipBytesLeft = 0;
    private passBytesLeft = 0;
    private readyToPush = false; // Mandatory for proper handling of backpressure feature

    private bytesProcessed = 0;
    private needMoreData: (err?: Error | null) => void = () => {};

    _write(chunk: Buffer, _enc: string, callback: (err?: Error | null) => void) {

        this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length);
        this.processData();

        // console.log(` READY (for more data)`)
        // this.needMoreData = callback;
        callback();
        // callback();

    }


    _read(size: number) {
        // IF size === 0 then just refresh
        if (size) {
            // console.log(`_read size ${size}`)
            if (typeof size !== "number"  ||  size < 0) {
                this.destroy( new Error(`JpegExifFilter invalid usage error. Stream that reads from JpegExifFilter instace called read(size) with invalid size argument. Expected number >= 0. Actual: ${size}`) );
            }
            this.readSize = size;
        }

        this.readyToPush = true;
        this.processData();
    }



    private processData(recCall = 0) {
        if (this.data.length > maxLen) {
            maxLen = this.data.length;
            console.log(` NEW MAX LEN: ${maxLen}`)
        }
        if (recCall > maxRecCall) {
            maxRecCall = recCall;
            console.log(` NEW MAX RECURRENCE CALL: ${maxRecCall}`)
        }

        if ( ! this.readyToPush) {
            return;
        }

// console.log(`STATE: ${this.state}`)
        // TODO decrease memory usage by eliminating recurence calls:
        // - simulate PTC (proper tail call) using while/continue


        switch (this.state) {


            case eState.EXPECT_SOI: {

                if (this.data.length < 2) {
                    this.needMoreData();
                    break; // wait for more data
                }

                let marker = this.getMarker();

                if ( this.isSoiMarker(marker) ) {
                    this.destroy( new Error(`Stream is not JPEG. Expected first bytes to be 0xFFD8. Actual: 0x${marker.toString(16).toUpperCase()}`) );
                    return;
                }

                this.queueNext(eState.EXPECT_MARKER);
                this.passBytes(2);
                this.processData(recCall + 1);

                break;
            }


            case eState.EXPECT_MARKER: {

                if (this.data.length < 2) {
                    this.needMoreData();
                    break; // wait for more data
                }

                let marker = this.getMarker();

                // Purpose of this library is to remove exif (and any other application or unnecessary data) from image.
                // Not sure of JPEG extension markers purpose (this.isJpegMarker()) so I propose to keep them.
                if ( this.isMandatoryMarkerWihtKnownLength(marker) || this.isJpgMarker(marker) ) {
                    this.queueNext(eState.MANDATORY_MARKER_FOUND);
                    this.processData(recCall + 1);
                    break;

                }
                // IMO. COM (comment) marker segment is redundant
                else if ( this.isAppMarker(marker) || this.isComMarker(marker) ) {
                    this.queueNext(eState.REDUNDANT_MARKER_FOUND);
                    this.processData(recCall + 1);
                    break;

                }
                else if ( this.isSosMarker(marker) ) {
                    this.queueNext(eState.SOS_MARKER_FOUND); // Mandatory marker with special treatment
                    this.processData(recCall + 1);
                    break;

                }
                else if ( this.isEoiMarker(marker) ) {
                    this.queueNext(eState.EOI_FOUND);
                    this.processData(recCall + 1);
                    break;

                }
                else {
                    this.destroy( new Error(`JpegExifFilter input stream data error. Details: expecting known JPEG data marker. Unkown marker found 0x${marker.toString(16).toUpperCase()} at byte ${this.bytesProcessed}`) );
                    break;
                }
            }


            case eState.REDUNDANT_MARKER_FOUND: {

                if (this.data.length < 4) {
                    this.needMoreData();
                    break; // wait for more data
                }

                this.skipBytesLeft = this.getMarkerAndDataLength();

                this.queueNext(eState.SKIP_BYTES);
                this.processData(recCall + 1);

                break;
            }


            case eState.SKIP_BYTES: {

                if ( ! this.data.length) {
                    this.needMoreData();
                    break; // wait for more data
                }

                let numOfBytesToSkip = Math.min(this.skipBytesLeft, this.data.length);
                this.skipBytes(numOfBytesToSkip);
                this.skipBytesLeft -= numOfBytesToSkip;

                // console.log(`Bytes to skip left ${this.skipBytesLeft}`)

                if ( ! this.skipBytesLeft) {
                    this.queueNext( eState.EXPECT_MARKER);
                    this.processData(recCall + 1);
                    break;
                }
                else {
                    // Need to skip more bytes but whole buffer emptied - wait for more data.
                    // Same step (state) will be repeated when more data available.
                }

                break;
            }


            case eState.MANDATORY_MARKER_FOUND: {
                if (this.data.length < 4) {
                    this.needMoreData();
                    break; // wait for more data
                }

                this.passBytesLeft = this.getMarkerAndDataLength();

                this.queueNext(eState.PASS_BYTES);
                this.processData(recCall + 1);

                break;
            }


            case eState.PASS_BYTES: {

                if ( ! this.data.length) {
                    this.needMoreData();
                    break; // wait for more data
                }

                if ( ! this.passBytesLeft) {
                    this.queueNext( eState.EXPECT_MARKER);
                    this.processData(recCall + 1);
                    break;
                }
                else {
                    // Neet do pass more bytes but whole buffer emptied - need to wait for more data.
                    // Same step (state) will be repeated when more data available.
                }

                let numOfBytesToPass = Math.min(this.passBytesLeft, this.data.length, this.readSize);
                this.passBytesLeft -= numOfBytesToPass;
                this.passBytes(numOfBytesToPass);

                break;
            }


            case eState.SOS_MARKER_FOUND: {

                if (this.data.length < 5) {
                    this.needMoreData();
                    break; // wait for more data
                }

                this.queueNext(eState.PASS_BYTES_UNTIL_NEXT_NON_SOS_MARKER);
                this.passBytes(5);
                this.processData(recCall + 1);


                break;
            }


            case eState.PASS_BYTES_UNTIL_NEXT_NON_SOS_MARKER: {
                if (this.data.length < 2) {
                    this.needMoreData();
                    break; // wait for more data
                }

                let index;
                let offset = 0;

                while( (index = this.data.indexOf("ff", offset, "hex")) >= 0) {

                    // Need 2 bytes to read whole marker
                    if (index + 2 > this.data.length ) {
                        // Found begin of marker (0xFF) but it is end of data buffer so I am unable to check what marker it is
                        // Need to wait for at least one more byte.

                        // Pass all but last byte (keep last 0xFF).
                        // Last 0xFF will be necessary when more data will arrive to properly read marker.
                        this.passAllBytesExceptLast(1);

                        this.needMoreData();
                        break; // wait for more data
                    }


                    let potentialMarker = this.getMarker(index);

                    if ( this.isNextMarkerThatEndsSosData(potentialMarker) ) {
                        this.queueNext(eState.EXPECT_MARKER);

                        // Do not pass 0 bytes
                        if (index) {
                            this.passBytes(index);
                        }
                        this.processData(recCall + 1);
                        break;
                    }


                    // Nothing found, increase search offset and continue to search
                    offset = index + 2; // 2 bytes after
                }

                // Nothig found - pass all and wait for more data
                if (this.data.length) {
                    this.passBytes(this.data.length);
                }
                this.needMoreData();

                break;
            }


            case eState.EOI_FOUND: {
                this.queueNext(eState.END);
console.log(` MAX DATA LEN ${maxLen}`);
console.log(` MAX NUM OF RECURSION ${maxRecCall}`);
                this.passBytes(2); // PASS EOI

                if (this.data.length) {
                    this.destroy( new Error(`JpegExifFilter internal error. Details: Expected whole data buffer pushed. Bytes left: ${this.data.length}`) );
                    break;
                }

                this.processData(recCall + 1);
            }


            case eState.END: {
                this.push(null);
                // Done, do nothing (should be called only once)
                break;
            }


            default: {
                this.destroy( new Error(`JpegExifFilter internal error. Details: processData() unknown state: ${this.state}`) );
            }
        }


    }


    private queueNext(state: eState) {
        this.state = state;
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


    private getMarkerAndDataLength(index = 0) {
        // Expecting 0xMMMMSSSS
        // M - marker
        // S - data length (uint16 big endian)

        // Double check. I should ensure that I have enough bytes in this.data buffer before call getMarkerAndDataLength().
        if (this.data.length - index < 4) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: getMarkerAndDataLength() not enough data (${this.data.length} bytes) to read marker length at position ${index}.`) );
        }

        // 2 bytes of marker + segment length (including 2 bytes that contains length value)
        return ( 2 + this.data.readUInt16BE(2) );
    }


    private passBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call passBytes().
        if (this.data.length < length || length < 1) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: passBytes() not enough data inside internal buffer (${this.data.length} bytes) to pass ${length} bytes.`) );
        }

        let dataToPush = this.data.slice(0, length);
        this.data = this.data.slice(length);

// console.log(`# Pass ${dataToPush.toString("hex")}  (next: ${this.data.toString("hex").substr(0,10)})`);
        this.bytesProcessed += length;
        this.readyToPush = this.push(dataToPush);
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

        // console.log(`# Pass ${dataToPush.toString("hex")}  (next: ${this.data.toString("hex").substr(0,10)})`);
        this.bytesProcessed += length;
        this.readyToPush = this.push(dataToPush);
    }


    private skipBytes(length: number) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call skipBytes().
        if (this.data.length < length || length < 1) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: skipBytes() not enough data inside internal buffer (${this.data.length} bytes) to skip ${length} bytes.`) );
        }

        this.bytesProcessed += length;
        // let skippedData = this.data.slice(0, length);
        this.data = this.data.slice(length);
        // console.log(`# Skip ${skippedData.toString("hex")}  (next: ${this.data.toString("hex").substr(0,10)})`);
    }


    private getMarker(index = 0) {
        // Double check. I should ensure that I have enough bytes in this.data buffer before call getMarker().
        if (this.data.length - index < 2) {
            this.destroy( new Error(`JpegExifFilter internal error. Details: getMarker() not enough data inside internal buffer (${this.data.length} bytes) to read marker at position ${index}.`) );
        }

        return this.data.readUInt16BE(index);
    }
}



export function getJpegExifFilter(opts?: DuplexOptions) {
    return new JpegExifFilter(opts);
}
