/* jslint node: true */
/* global window */
'use strict';

var _ = require('lodash');
var FontProvider = require('./fontProvider');
var LayoutBuilder = require('./layoutBuilder');
var PdfKit = require('pdfkit');
var PDFReference = require('pdfkit/js/reference');
var sizes = require('./standardPageSizes');
var ImageMeasure = require('./imageMeasure');
var textDecorator = require('./textDecorator');

_.noConflict();

////////////////////////////////////////
// PdfPrinter

/**
 * @class Creates an instance of a PdfPrinter which turns document definition into a pdf
 *
 * @param {Object} fontDescriptors font definition dictionary
 *
 * @example
 * var fontDescriptors = {
 *	Roboto: {
 *		normal: 'fonts/Roboto-Regular.ttf',
 *		bold: 'fonts/Roboto-Medium.ttf',
 *		italics: 'fonts/Roboto-Italic.ttf',
 *		bolditalics: 'fonts/Roboto-Italic.ttf'
 *	}
 * };
 *
 * var printer = new PdfPrinter(fontDescriptors);
 */
function PdfPrinter(fontDescriptors) {
  this.fontDescriptors = fontDescriptors;
}

/**
 * Executes layout engine for the specified document and renders it into a pdfkit document
 * ready to be saved.
 *
 * @param {Object} docDefinition document definition
 * @param {Object} docDefinition.content an array describing the pdf structure (for more information take a look at the examples in the /examples folder)
 * @param {Object} [docDefinition.defaultStyle] default (implicit) style definition
 * @param {Object} [docDefinition.styles] dictionary defining all styles which can be used in the document
 * @param {Object} [docDefinition.patterns] dictionary defining all color patterns which can be used in the document
 * @param {Object} [docDefinition.pageSize] page size (pdfkit units, A4 dimensions by default)
 * @param {Number} docDefinition.pageSize.width width
 * @param {Number} docDefinition.pageSize.height height
 * @param {Object} [docDefinition.pageMargins] page margins (pdfkit units)
 *
 * @example
 *
 * var docDefinition = {
 * 	info: {
 *		title: 'awesome Document',
 *		author: 'john doe',
 *		subject: 'subject of document',
 *		keywords: 'keywords for document',
 * 	},
 *	content: [
 *		'First paragraph',
 *		'Second paragraph, this time a little bit longer',
 *		{ text: 'Third paragraph, slightly bigger font size', fontSize: 20 },
 *		{ text: 'Another paragraph using a named style', style: 'header' },
 *		{ text: ['playing with ', 'inlines' ] },
 *		{ text: ['and ', { text: 'restyling ', bold: true }, 'them'] },
 *	],
 *	styles: {
 *		header: { fontSize: 30, bold: true }
 *	},
 *  patterns: {
 *    stripe45d: {
 *      boundingBox: [1, 1, 4, 4],
 *      xStep: 3,
 *      yStep: 3,
 *      pattern: '1 w 0 1 m 4 5 l s 2 0 m 5 3 l s'
 *    }
 *  }
 * }
 *
 * var pdfKitDoc = printer.createPdfKitDocument(docDefinition);
 *
 * pdfKitDoc.pipe(fs.createWriteStream('sample.pdf'));
 * pdfKitDoc.end();
 *
 * @return {Object} a pdfKit document object which can be saved or encode to data-url
 */
PdfPrinter.prototype.createPdfKitDocument = function(docDefinition, options) {
  options = options || {};

  var pageSize = PdfPrinter.fixPageSize(
    docDefinition.pageSize,
    docDefinition.pageOrientation
  );
  this.pdfKitDoc = new PdfKit({
    size: [pageSize.width, pageSize.height],
    compress: false
  });
  this.pdfKitDoc.info.Producer = 'pdfmake';
  this.pdfKitDoc.info.Creator = 'pdfmake';

  // pdf kit maintains the uppercase fieldnames from pdf spec
  // to keep the pdfmake api consistent, the info field are defined lowercase
  if (docDefinition.info) {
    var info = docDefinition.info;
    // check for falsey an set null, so that pdfkit always get either null or value
    this.pdfKitDoc.info.Title = docDefinition.info.title
      ? docDefinition.info.title
      : null;
    this.pdfKitDoc.info.Author = docDefinition.info.author
      ? docDefinition.info.author
      : null;
    this.pdfKitDoc.info.Subject = docDefinition.info.subject
      ? docDefinition.info.subject
      : null;
    this.pdfKitDoc.info.Keywords = docDefinition.info.keywords
      ? docDefinition.info.keywords
      : null;
  }

  this.fontProvider = new FontProvider(this.fontDescriptors, this.pdfKitDoc);

  docDefinition.images = docDefinition.images || {};

  var builder = new LayoutBuilder(
    pageSize,
    PdfPrinter.fixPageMargins(docDefinition.pageMargins || 40),
    new ImageMeasure(this.pdfKitDoc, docDefinition.images)
  );

  registerDefaultTableLayouts(builder);
  if (options.tableLayouts) {
    builder.registerTableLayouts(options.tableLayouts);
  }

  var pages = builder.layoutDocument(
    docDefinition.content,
    this.fontProvider,
    docDefinition.styles || {},
    docDefinition.defaultStyle || { fontSize: 12, font: 'Roboto' },
    docDefinition.background,
    docDefinition.header,
    docDefinition.footer,
    docDefinition.images,
    docDefinition.watermark,
    docDefinition.pageBreakBefore
  );

  var patterns = createPatterns(docDefinition.patterns || {}, this.pdfKitDoc);

  renderPages(pages, this.fontProvider, patterns, this.pdfKitDoc);

  if (options.autoPrint) {
    var printActionRef = this.pdfKitDoc.ref({
      Type: 'Action',
      S: 'Named',
      N: 'Print'
    });
    this.pdfKitDoc._root.data.OpenAction = printActionRef;
    printActionRef.end();
  }

  return this.pdfKitDoc;
};

PdfPrinter.fixPageSize = function(pageSize, pageOrientation) {
  var size = pageSize2widthAndHeight(pageSize || 'a4');
  if (pageOrientation === 'landscape') {
    size = { width: size.height, height: size.width };
  }
  size.orientation =
    pageOrientation === 'landscape' ? pageOrientation : 'portrait';
  return size;
};

PdfPrinter.fixPageMargins = function(margin) {
  if (!margin) return null;

  if (typeof margin === 'number' || margin instanceof Number) {
    margin = { left: margin, right: margin, top: margin, bottom: margin };
  } else if (margin instanceof Array) {
    if (margin.length === 2) {
      margin = {
        left: margin[0],
        top: margin[1],
        right: margin[0],
        bottom: margin[1]
      };
    } else if (margin.length === 4) {
      margin = {
        left: margin[0],
        top: margin[1],
        right: margin[2],
        bottom: margin[3]
      };
    } else throw 'Invalid pageMargins definition';
  }
  return margin;
};

function registerDefaultTableLayouts(layoutBuilder) {
  layoutBuilder.registerTableLayouts({
    noBorders: {
      hLine: function(i) {
        return { width: 0 };
      },
      vLine: function(i) {
        return { width: 0 };
      },
      paddingLeft: function(i) {
        return (i && 4) || 0;
      },
      paddingRight: function(i, node) {
        return i < node.table.widths.length - 1 ? 4 : 0;
      }
    },
    headerLineOnly: {
      hLine: function(i, node) {
        if (i === 0 || i === node.table.body.length) return { width: 0 };
        return { width: i === node.table.headerRows ? 2 : 0 };
      },
      vLine: function(i) {
        return { width: 0 };
      },
      paddingLeft: function(i) {
        return i === 0 ? 0 : 8;
      },
      paddingRight: function(i, node) {
        return i === node.table.widths.length - 1 ? 0 : 8;
      }
    },
    lightHorizontalLines: {
      hLine: function(i, node) {
        if (i === 0 || i === node.table.body.length) return { width: 0 };
        if (i === node.table.headerRows) return { width: 2 };
        return { width: 1, color: '#aaa' };
      },
      vLine: function(i) {
        return { width: 0 };
      },
      hLineColor: function(i) {
        return i === 1 ? 'black' : '#aaa';
      },
      paddingLeft: function(i) {
        return i === 0 ? 0 : 8;
      },
      paddingRight: function(i, node) {
        return i === node.table.widths.length - 1 ? 0 : 8;
      }
    }
  });
}

function pageSize2widthAndHeight(pageSize) {
  if (typeof pageSize == 'string' || pageSize instanceof String) {
    var size = sizes[pageSize.toUpperCase()];
    if (!size) throw 'Page size ' + pageSize + ' not recognized';
    return { width: size[0], height: size[1] };
  }

  return pageSize;
}

function StringObject(str) {
  this.isString = true;
  this.toString = function() {
    return str;
  };
}

function updatePageOrientationInOptions(currentPage, pdfKitDoc) {
  var previousPageOrientation =
    pdfKitDoc.options.size[0] > pdfKitDoc.options.size[1]
      ? 'landscape'
      : 'portrait';

  if (currentPage.pageSize.orientation !== previousPageOrientation) {
    var width = pdfKitDoc.options.size[0];
    var height = pdfKitDoc.options.size[1];
    pdfKitDoc.options.size = [height, width];
  }
}

function renderPages(pages, fontProvider, patterns, pdfKitDoc) {
  pdfKitDoc._pdfMakePages = pages;
  for (var i = 0; i < pages.length; i++) {
    if (i > 0) {
      updatePageOrientationInOptions(pages[i], pdfKitDoc);
      pdfKitDoc.addPage(pdfKitDoc.options);
    }

    var page = pages[i];
    for (var ii = 0, il = page.items.length; ii < il; ii++) {
      var item = page.items[ii];
      switch (item.type) {
        case 'vector':
          renderVector(item.item, patterns, pdfKitDoc);
          break;
        case 'line':
          renderLine(item.item, item.item.x, item.item.y, pdfKitDoc);
          break;
        case 'image':
          renderImage(item.item, item.item.x, item.item.y, pdfKitDoc);
          break;
        case 'beginClip':
          beginClip(item.item, pdfKitDoc);
          break;
        case 'endClip':
          endClip(pdfKitDoc);
          break;
        case 'beginVerticalAlign':
          beginVerticalAlign(item.item, pdfKitDoc);
          break;
        case 'endVerticalAlign':
          endVerticalAlign(item.item, pdfKitDoc);
          break;
        case 'beginRotate':
          beginRotate(item.item, pdfKitDoc);
          break;
        case 'endRotate':
          endRotate(pdfKitDoc);
          break;
      }
    }
    if (page.watermark) {
      renderWatermark(page, pdfKitDoc);
    }

    fontProvider.setFontRefsToPdfDoc();
  }
}

function beginClip(rect, pdfKitDoc) {
  pdfKitDoc.save();
  pdfKitDoc.addContent(
    '' + rect.x + ' ' + rect.y + ' ' + rect.width + ' ' + rect.height + ' re'
  );
  pdfKitDoc.clip();
}

function endClip(pdfKitDoc) {
  pdfKitDoc.restore();
}

function beginVerticalAlign(item, pdfKitDoc) {
  switch (item.verticalAlign) {
    case 'center':
      pdfKitDoc.save();
      pdfKitDoc.translate(0, -(item.nodeHeight - item.viewHeight) / 2);
      break;
    case 'bottom':
      pdfKitDoc.save();
      pdfKitDoc.translate(0, -(item.nodeHeight - item.viewHeight));
      break;
  }
}

function endVerticalAlign(item, pdfKitDoc) {
  switch (item.verticalAlign) {
    case 'center':
    case 'bottom':
      pdfKitDoc.restore();
      break;
  }
}

function beginRotate(item, pdfKitDoc) {
  pdfKitDoc.save();
  pdfKitDoc.translate(
    item.rotate[0] - item.rotate[1],
    item.y + item.viewHeight + item.x + item.rotate[0]
  );
  pdfKitDoc.rotate(-90);
}

function endRotate(pdfKitDoc) {
  pdfKitDoc.restore();
}

function renderLine(line, x, y, pdfKitDoc) {
  x = x || 0;
  y = y || 0;

  var lineHeight = line.getHeight();
  var lineWidth = line.getWidth();
  var ascenderHeight = line.getAscenderHeight();

  pdfKitDoc.save();
  if (lineWidth > line.maxWidth || line.clipHeight) {
    var alignment =
      line.inlines && line.inlines.length > 0 && line.inlines[0].alignment;
    var offset = 0;
    switch (alignment) {
      case 'right':
        offset = lineWidth - line.maxWidth;
        break;
      case 'center':
        offset = (lineWidth - line.maxWidth) / 2;
        break;
    }
    pdfKitDoc.addContent(
      '' +
        (x + offset) +
        ' ' +
        y +
        ' ' +
        (line.maxWidth - 1) +
        ' ' +
        (line.clipHeight || lineHeight) +
        ' re'
    );
    pdfKitDoc.clip();
  }

  textDecorator.drawBackground(line, x, y, pdfKitDoc);

  //TODO: line.optimizeInlines();
  for (var i = 0, l = line.inlines.length; i < l; i++) {
    var inline = line.inlines[i];

    pdfKitDoc.fill(inline.color || 'black');

    pdfKitDoc.save();
    pdfKitDoc.transform(1, 0, 0, -1, 0, pdfKitDoc.page.height);

    var encoded = inline.font.encode(inline.text);

    pdfKitDoc.addContent('BT');

    pdfKitDoc.addContent(
      '' +
        (x + inline.x) +
        ' ' +
        (pdfKitDoc.page.height - y - ascenderHeight) +
        ' Td'
    );
    pdfKitDoc.addContent('/' + encoded.fontId + ' ' + inline.fontSize + ' Tf');

    pdfKitDoc.addContent('<' + encoded.encodedText + '> Tj');

    pdfKitDoc.addContent('ET');

    if (inline.link) {
      pdfKitDoc.link(
        x + inline.x,
        pdfKitDoc.page.height - y - lineHeight,
        inline.width,
        lineHeight,
        inline.link
      );
    }

    pdfKitDoc.restore();
  }

  textDecorator.drawDecorations(line, x, y, pdfKitDoc);

  pdfKitDoc.restore();
}

function renderWatermark(page, pdfKitDoc) {
  var watermark = page.watermark;

  pdfKitDoc.save();
  pdfKitDoc.fill(watermark.color);
  pdfKitDoc.opacity(watermark.opacity);

  pdfKitDoc.transform(1, 0, 0, -1, 0, pdfKitDoc.page.height);

  var angle =
    Math.atan2(pdfKitDoc.page.height, pdfKitDoc.page.width) * 180 / Math.PI;
  pdfKitDoc.rotate(angle, {
    origin: [pdfKitDoc.page.width / 2, pdfKitDoc.page.height / 2]
  });

  var encoded = watermark.font.encode(watermark.text);
  pdfKitDoc.addContent('BT');
  pdfKitDoc.addContent(
    '' +
      (pdfKitDoc.page.width / 2 - watermark.size.size.width / 2) +
      ' ' +
      (pdfKitDoc.page.height / 2 - watermark.size.size.height / 4) +
      ' Td'
  );
  pdfKitDoc.addContent(
    '/' + encoded.fontId + ' ' + watermark.size.fontSize + ' Tf'
  );
  pdfKitDoc.addContent('<' + encoded.encodedText + '> Tj');
  pdfKitDoc.addContent('ET');
  pdfKitDoc.restore();
}

function renderVector(vector, patterns, pdfKitDoc) {
  //TODO: pdf optimization (there's no need to write all properties everytime)
  pdfKitDoc.save();
  pdfKitDoc.lineWidth(vector.lineWidth || 1);
  if (vector.dash) {
    pdfKitDoc.dash(vector.dash.length, {
      space: vector.dash.space || vector.dash.length,
      phase: vector.dash.phase || 0
    });
  } else {
    pdfKitDoc.undash();
  }
  pdfKitDoc.fillOpacity(vector.fillOpacity || 1);
  pdfKitDoc.strokeOpacity(vector.strokeOpacity || 1);
  pdfKitDoc.lineJoin(vector.lineJoin || 'miter');

  //TODO: clipping

  switch (vector.type) {
    case 'ellipse':
      pdfKitDoc.ellipse(vector.x, vector.y, vector.r1, vector.r2);
      break;
    case 'rect':
      if (vector.r) {
        pdfKitDoc.roundedRect(vector.x, vector.y, vector.w, vector.h, vector.r);
      } else {
        pdfKitDoc.rect(vector.x, vector.y, vector.w, vector.h);
      }
      break;
    case 'line':
      pdfKitDoc.moveTo(vector.x1, vector.y1);
      pdfKitDoc.lineTo(vector.x2, vector.y2);
      break;
    case 'polyline':
      if (vector.points.length === 0) break;

      pdfKitDoc.moveTo(vector.points[0].x, vector.points[0].y);
      for (var i = 1, l = vector.points.length; i < l; i++) {
        pdfKitDoc.lineTo(vector.points[i].x, vector.points[i].y);
      }

      if (vector.points.length > 1) {
        var p1 = vector.points[0];
        var pn = vector.points[vector.points.length - 1];

        if (vector.closePath || (p1.x === pn.x && p1.y === pn.y)) {
          pdfKitDoc.closePath();
        }
      }
      break;
  }

  if (vector.color && vector.lineColor) {
    pdfKitDoc.fillAndStroke(vector.color, vector.lineColor);
  } else if (vector.pattern && vector.lineColor) {
    pdfKitDoc.fillAndStroke(
      [patterns[vector.pattern[0]], vector.pattern[1]],
      vector.lineColor
    );
  } else if (vector.color) {
    pdfKitDoc.fill(vector.color);
  } else if (vector.pattern) {
    pdfKitDoc.fill([patterns[vector.pattern[0]], vector.pattern[1]]);
  } else {
    pdfKitDoc.stroke(vector.lineColor || 'black');
  }
  pdfKitDoc.restore();
}

function renderImage(image, x, y, pdfKitDoc) {
  pdfKitDoc.image(image.image, image.x, image.y, {
    width: image._width,
    height: image._height
  });
}

function createPatterns(patternDefinitions, pdfKitDoc) {
  var patterns = {};
  Object.keys(patternDefinitions).forEach(function(pKey) {
    var p = patternDefinitions[pKey];
    patterns[pKey] = pdfKitDoc.pattern(
      p.boundingBox,
      p.xStep,
      p.yStep,
      p.pattern,
      p.colored
    );
  });
  return patterns;
}

module.exports = PdfPrinter;

/* temporary browser extension */
PdfPrinter.prototype.fs = require('fs');
