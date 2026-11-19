// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PixelFilterRegistry
/// @notice Registro on-chain de *metadatos* de filtros de imagen.
///
/// El punto pedagógico: la ABI de Ethereum sirve para registrar y consultar
/// configuración (nombre, modo, versión, hash de parámetros), no para subir
/// píxeles. Un frame RGBA de 1 MB costaría ~16,8 M de gas solo en calldata.
/// El procesamiento real ocurre en el cliente, en WebAssembly.
contract PixelFilterRegistry {
    struct Filter {
        string name;
        uint8 mode; // 0 = grayscale, 1 = invert, 2 = sepia
        uint32 version;
        bytes32 paramsHash;
        bool enabled;
    }

    mapping(bytes32 id => Filter) private _filters;

    event FilterRegistered(
        bytes32 indexed id,
        string name,
        uint8 mode,
        uint32 version,
        bytes32 paramsHash
    );
    event FilterEnabledChanged(bytes32 indexed id, bool enabled);

    error FilterAlreadyExists(bytes32 id);
    error FilterNotFound(bytes32 id);
    error InvalidMode(uint8 mode);

    /// @notice Registra un filtro nuevo. El id suele ser keccak256(name).
    function registerFilter(
        bytes32 id,
        string calldata name,
        uint8 mode,
        uint32 version,
        bytes32 paramsHash
    ) external {
        if (bytes(_filters[id].name).length != 0) revert FilterAlreadyExists(id);
        if (mode > 2) revert InvalidMode(mode);

        _filters[id] = Filter(name, mode, version, paramsHash, true);
        emit FilterRegistered(id, name, mode, version, paramsHash);
    }

    function setEnabled(bytes32 id, bool enabled) external {
        Filter storage filter = _filters[id];
        if (bytes(filter.name).length == 0) revert FilterNotFound(id);
        filter.enabled = enabled;
        emit FilterEnabledChanged(id, enabled);
    }

    /// @notice Devuelve la tupla completa (string dinámico incluido).
    function getFilter(bytes32 id)
        external
        view
        returns (
            string memory name,
            uint8 mode,
            uint32 version,
            bytes32 paramsHash,
            bool enabled
        )
    {
        Filter storage filter = _filters[id];
        if (bytes(filter.name).length == 0) revert FilterNotFound(id);
        return (filter.name, filter.mode, filter.version, filter.paramsHash, filter.enabled);
    }

    /// @notice Id determinista para un nombre, calculado on-chain.
    function idFor(string calldata name) external pure returns (bytes32) {
        return keccak256(bytes(name));
    }
}
